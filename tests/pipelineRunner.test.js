// tests/pipelineRunner.test.js
//
// C1: tests del runner de pipeline con checkpoints (pipelineRunner.js). Se
// ejecutan SOLO contra los inyectables de ejecutarPipelineTick (store, ejecutar,
// avisarAdmin, guardarRun*, omitirScraper, evaluarScraper, sleep, ahora): ni un
// solo fetch real ni un Supabase real. Un reloj falso controla el presupuesto
// (budgetMs) para provocar pausas deterministas.
//
// Cobertura: reanudacion tras budget, reanudacion de una fase batched a mitad,
// la sombra salta las fases outbound, abort + aviso admin, claim/heartbeat y
// reset. Se anaden unos tests del store real (crearPipelineJobsStore) contra un
// fake de supabase para el claim atomico y la perdida de claim.

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.CRON_TOKEN = process.env.CRON_TOKEN || 'token-de-test-suficiente';
process.env.PIPELINE_SCRAPE_PATHS = '/scrape-test-oficial';

const assert = require('assert');
const { ejecutarPipelineTick, crearEjecutorHttp, verificarBaseUrlInterna } = require('../src/modules/tareas/pipelineRunner');
const {
  anadirEventoRecuperacion,
  crearEventoRecuperacion,
  crearPipelineJobsStore,
  diagnosticarPipelineJob,
  registrarClaimRecuperacion,
} = require('../src/modules/tareas/pipelineJobs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`OK: ${name}`);
    })
    .catch((err) => {
      failed += 1;
      console.error(`FAIL: ${name}`);
      console.error(err.stack || err.message);
      process.exitCode = 1;
    });
}

const FECHA = '2026-07-06';

// --- Dobles de prueba --------------------------------------------------------

// Reloj falso: el runner solo mira ahora() (para deadline/presupuesto). El
// avance se dispara desde el ejecutor, imitando el tiempo que consume cada fase.
function crearReloj(inicio = 0) {
  let t = inicio;
  return {
    ahora: () => t,
    avanzar: (ms) => {
      t += ms;
    },
  };
}

// Store en memoria que imita el contrato de crearPipelineJobsStore: un unico job
// mutado en sitio, con claim por tickId y un log de lo ocurrido.
function crearStoreFake({ job: jobOverrides = {}, reclamarDevuelveNull = false, competitiveClaim = false } = {}) {
  const job = {
    id: 1,
    kind: 'daily',
    fecha: FECHA,
    shadow: false,
    status: 'pending',
    current_stage: null,
    stages_json: {},
    options_json: { complementarios: false, fega: false },
    claimed_by: null,
    heartbeat_at: null,
    ticks: 0,
    started_at: null,
    finished_at: null,
    error_msg: null,
    ...jobOverrides,
  };
  const log = { guardados: [], reclamos: 0, liberado: false, reabierto: false, ultimoReclamo: null };

  const store = {
    job,
    log,
    async obtenerOCrear() {
      return job;
    },
    async reabrir({ jobId, job: previousJob = job, reason = 'manual_reopen', now = new Date() }) {
      assert.strictEqual(jobId, job.id);
      job.options_json = anadirEventoRecuperacion(
        previousJob.options_json || {},
        crearEventoRecuperacion({ job: previousJob, reason, action: 'reopen', now })
      );
      job.status = 'pending';
      job.error_msg = null;
      job.claimed_by = null;
      job.finished_at = null;
      log.reabierto = true;
      return { ...job };
    },
    async reclamar({ job: j, tickId, staleMs, now }) {
      log.reclamos += 1;
      log.ultimoReclamo = { jobId: j.id, tickId, staleMs, now };
      if (reclamarDevuelveNull || (competitiveClaim && job.claimed_by)) return null;
      const diagnostic = diagnosticarPipelineJob(j, { now, staleMs });
      if (diagnostic.stale) {
        job.options_json = anadirEventoRecuperacion(
          job.options_json || {},
          crearEventoRecuperacion({
            job: j,
            reason: diagnostic.recovery_reason,
            action: 'claim_takeover',
            tickId,
            now,
          })
        );
      } else {
        job.options_json = registrarClaimRecuperacion(job.options_json || {}, tickId, now);
      }
      job.status = 'running';
      job.claimed_by = tickId;
      job.ticks = Number(job.ticks || 0) + 1;
      job.started_at = job.started_at || (now ? now.toISOString() : new Date().toISOString());
      job.heartbeat_at = now ? now.toISOString() : new Date().toISOString();
      return { ...job };
    },
    async guardar({ jobId, tickId, patch = {} }) {
      assert.strictEqual(jobId, job.id);
      if (job.claimed_by !== tickId) throw new Error('pipeline_job_claim_perdido');
      Object.assign(job, patch);
      log.guardados.push({ tickId, patch });
      return { ...job };
    },
    async liberar({ jobId, tickId }) {
      log.liberado = true;
      if (job.claimed_by === tickId) job.claimed_by = null;
    },
    async listar() {
      return [job];
    },
  };
  return store;
}

// Ejecutor HTTP falso: registra cada llamada, opcionalmente avanza el reloj un
// fijo por llamada y devuelve el body configurado por path (o porDefecto).
function crearEjecutar({ reloj = null, avanceMs = 0, respuestas = {}, porDefecto = () => ({ procesadas: 0 }) } = {}) {
  const fn = async (path, method = 'GET') => {
    fn.llamadas.push({ path, method });
    if (reloj && avanceMs) reloj.avanzar(avanceMs);
    const handler = Object.prototype.hasOwnProperty.call(respuestas, path) ? respuestas[path] : porDefecto;
    const body = typeof handler === 'function' ? handler(path) : handler;
    return { path, status: 200, body: body || {} };
  };
  fn.llamadas = [];
  fn.paths = () => fn.llamadas.map((c) => c.path);
  return fn;
}

// Bolsa de inyectables comun. omitirScraper por defecto OMITE los scrapers para
// no lidiar con su HTTP; los tests que miran scraper_runs lo sobreescriben.
function inyectables({ store, ejecutar, reloj, avisos, pipelineRuns, scraperRuns, omitirScraper }) {
  return {
    store,
    ejecutar,
    avisarAdmin: async (mensaje) => {
      avisos.push(mensaje);
      return { enviado: true };
    },
    guardarRunPipeline: async (_db, run) => {
      pipelineRuns.push(run);
    },
    guardarRunScraper: async (_db, run) => {
      scraperRuns.push(run);
    },
    omitirScraper: omitirScraper || (async () => ({ ok: true, omitido: true })),
    evaluarScraper: () => ({ severity: 'ok', flags: [] }),
    sleep: async () => {},
    ahora: reloj ? reloj.ahora : () => Date.now(),
  };
}

function contexto(extra = {}) {
  return { avisos: [], pipelineRuns: [], scraperRuns: [], ...extra };
}

// --- Tests -------------------------------------------------------------------

async function main() {
  console.log('\n=== TESTS: pipelineRunner (C1 runner con checkpoints) ===\n');

  await test('reanuda tras agotar el presupuesto: el 2o tick no repite fases completadas', async () => {
    const store = crearStoreFake();
    const ctx = contexto();

    // Tick 1: presupuesto justo para llegar hasta revisar; para en deduplicar.
    const reloj1 = crearReloj(0);
    const ejecutar1 = crearEjecutar({ reloj: reloj1, avanceMs: 10 });
    const r1 = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        budgetMs: 45,
        maxLoops: 5,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar: ejecutar1, reloj: reloj1, ...ctx }),
      }
    );

    assert.strictEqual(r1.tick, 'budget_exhausted');
    assert.strictEqual(r1.job.current_stage, 'deduplicar');
    assert.strictEqual(store.job.status, 'running'); // sigue vivo, no terminal
    assert(ejecutar1.paths().includes('/alertas/clasificar'), 'tick1 debio ejecutar clasificar');
    assert.strictEqual(store.log.liberado, true, 'debe liberar el claim al terminar el tick');

    // Tick 2: presupuesto de sobra; reanuda desde el checkpoint y completa.
    const ejecutar2 = crearEjecutar({});
    const r2 = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        budgetMs: 10_000_000,
        maxLoops: 5,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar: ejecutar2, reloj: null, ...ctx }),
      }
    );

    assert.strictEqual(r2.tick, 'completed');
    assert.strictEqual(store.job.status, 'completed');
    // Las fases ya completadas en el tick 1 NO se re-ejecutan en el tick 2.
    for (const yaHecha of ['/alertas/clasificar', '/alertas/resumir', '/alertas/revisar']) {
      assert(!ejecutar2.paths().includes(yaHecha), `tick2 no debe repetir ${yaHecha}`);
    }
    // Pero SI ejecuta lo que quedaba pendiente.
    assert(ejecutar2.paths().includes('/alertas/deduplicar'), 'tick2 debe ejecutar deduplicar');
    assert(ejecutar2.paths().includes('/alertas/enviar-digest'), 'tick2 debe llegar al envio');
  });

  await test('reanuda una fase batched a mitad y acumula procesadas entre ticks', async () => {
    const store = crearStoreFake();
    const ctx = contexto();
    const reloj = crearReloj(0); // reloj compartido entre los dos ticks

    // clasificar procesa lotes de 5 en las 3 primeras vueltas y luego vacia la
    // cola; cada vuelta consume 30ms para forzar la pausa por presupuesto.
    let vueltasClasificar = 0;
    const respuestas = {
      '/alertas/clasificar': () => {
        vueltasClasificar += 1;
        reloj.avanzar(30);
        return vueltasClasificar <= 3 ? { procesadas: 5, actualizadas: 5 } : { procesadas: 0, actualizadas: 0 };
      },
    };

    const ejecutar1 = crearEjecutar({ respuestas });
    const r1 = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        budgetMs: 55,
        maxLoops: 40,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar: ejecutar1, reloj, ...ctx }),
      }
    );

    assert.strictEqual(r1.tick, 'budget_exhausted');
    assert.strictEqual(r1.job.current_stage, 'clasificar');
    assert.strictEqual(store.job.stages_json.clasificar.status, 'pending', 'la fase pausada vuelve a pending');
    assert.strictEqual(store.job.stages_json.clasificar.loops, 2, 'tick1 dio 2 vueltas antes de la pausa');
    assert.strictEqual(store.job.stages_json.clasificar.total, 10, 'tick1 acumulo 2x5 procesadas');

    // Tick 2 (mismo reloj): presupuesto enorme; continua desde loops=2/total=10.
    const ejecutar2 = crearEjecutar({ respuestas });
    const r2 = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        budgetMs: 10_000_000,
        maxLoops: 40,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar: ejecutar2, reloj, ...ctx }),
      }
    );

    assert.strictEqual(r2.tick, 'completed');
    assert.strictEqual(store.job.stages_json.clasificar.status, 'completed');
    assert.strictEqual(store.job.stages_json.clasificar.total, 15, 'acumula la 3a vuelta (15 en total) tras la pausa');
    assert.strictEqual(store.job.stages_json.clasificar.loops, 4, 'tras la pausa: vuelta con lote + vuelta que vacia la cola');
  });

  await test('la sombra salta las fases outbound, no escribe scraper_runs y prefija pipeline_runs con shadow:', async () => {
    const store = crearStoreFake({ job: { shadow: true } });
    const ctx = contexto();
    // El scraper NO se omite: asi comprobamos que en sombra no se registra el run.
    const ejecutar = crearEjecutar({});
    const r = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        shadow: true,
        budgetMs: 10_000_000,
        maxLoops: 5,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar, reloj: null, omitirScraper: async () => null, ...ctx }),
      }
    );

    assert.strictEqual(r.tick, 'completed');
    assert.strictEqual(r.shadow, true);

    // Ninguna fase outbound se ejecuta por HTTP...
    for (const outbound of ['/alertas/enviar-digest', '/tareas/mia-outbox', '/alertas/enviar-resumen-free']) {
      assert(!ejecutar.paths().includes(outbound), `sombra no debe llamar ${outbound}`);
    }
    // ...y queda marcada como shadow_skipped en el checkpoint.
    for (const fase of ['enviar_digest', 'mia_outbox', 'enviar_resumen_free']) {
      assert.strictEqual(store.job.stages_json[fase].status, 'shadow_skipped', `${fase} debe quedar shadow_skipped`);
    }

    // Sombra NO escribe scraper_runs (para no contaminar el vigia de salud).
    assert.strictEqual(ctx.scraperRuns.length, 0, 'sombra no debe escribir scraper_runs');
    // El scraper SI se ejecuta (solo que sin persistir el run).
    assert(ejecutar.paths().includes('/scrape-test-oficial'), 'el scraper corre en sombra');

    // Todos los pipeline_runs van con stage prefijado shadow:.
    assert(ctx.pipelineRuns.length > 0, 'debe registrar pipeline_runs');
    for (const run of ctx.pipelineRuns) {
      assert(run.stage.startsWith('shadow:'), `stage debe ir con prefijo shadow: (${run.stage})`);
    }
    assert.strictEqual(ctx.avisos.length, 0, 'sin abortos, la sombra no avisa al admin');
  });

  await test('aborta antes del digest y avisa al admin cuando un lote queda bloqueado', async () => {
    const store = crearStoreFake();
    const ctx = contexto();
    // clasificar procesa pero no actualiza nada => lote bloqueado => abort.
    const respuestas = { '/alertas/clasificar': () => ({ procesadas: 5, actualizadas: 0 }) };
    const ejecutar = crearEjecutar({ respuestas });

    const r = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        budgetMs: 10_000_000,
        maxLoops: 5,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar, reloj: null, ...ctx }),
      }
    );

    assert.strictEqual(r.tick, 'aborted');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.job.status, 'aborted');
    assert.strictEqual(r.job.current_stage, 'clasificar');

    // Aviso al admin con la fase, el motivo y la URL de reset.
    assert.strictEqual(ctx.avisos.length, 1, 'debe avisar al admin una vez');
    const aviso = ctx.avisos[0];
    assert(/pipeline detenido/i.test(aviso), 'el aviso menciona pipeline detenido');
    assert(aviso.includes('clasificar'), 'el aviso nombra la fase');
    assert(aviso.includes(`reset=true`) && aviso.includes(FECHA), 'el aviso incluye la URL de reset con la fecha');

    // No se llega a enviar el digest.
    assert(!ejecutar.paths().includes('/alertas/enviar-digest'), 'no debe enviar digest tras abortar');

    // Se registra el run fallido de la fase y el job queda terminal.
    const runClasificar = ctx.pipelineRuns.find((run) => run.stage === 'clasificar');
    assert(runClasificar && runClasificar.status === 'error', 'pipeline_run de clasificar en error');
    assert.strictEqual(store.job.status, 'aborted');
    assert(store.job.finished_at, 'el job aborta con finished_at');
    assert.strictEqual(store.log.liberado, true, 'libera el claim incluso al abortar');
  });

  await test('claim: si otro tick tiene el job (claim ocupado) devuelve already_running sin ejecutar', async () => {
    const store = crearStoreFake({ job: { status: 'running', claimed_by: 'otro-tick' }, reclamarDevuelveNull: true });
    const ctx = contexto();
    const ejecutar = crearEjecutar({});

    const r = await ejecutarPipelineTick(
      {},
      { fecha: FECHA, budgetMs: 10_000, ...inyectables({ store, ejecutar, reloj: null, ...ctx }) }
    );

    assert.strictEqual(r.tick, 'already_running');
    assert.strictEqual(store.log.reclamos, 1, 'se intento reclamar');
    assert.strictEqual(ejecutar.llamadas.length, 0, 'no ejecuta ninguna fase');
    assert.strictEqual(store.log.liberado, false, 'sin claim no hay nada que liberar');
  });

  await test('claim: dos ticks simultaneos producen un solo ejecutor', async () => {
    const store = crearStoreFake({ competitiveClaim: true });
    const first = ejecutarPipelineTick({}, {
      fecha: FECHA,
      budgetMs: 10_000_000,
      stepDelayMs: 0,
      ...inyectables({ store, ejecutar: crearEjecutar({}), reloj: null, ...contexto() }),
    });
    const second = ejecutarPipelineTick({}, {
      fecha: FECHA,
      budgetMs: 10_000_000,
      stepDelayMs: 0,
      ...inyectables({ store, ejecutar: crearEjecutar({}), reloj: null, ...contexto() }),
    });
    const results = await Promise.all([first, second]);
    assert.strictEqual(results.filter(({ tick }) => tick === 'completed').length, 1);
    assert.strictEqual(results.filter(({ tick }) => tick === 'already_running').length, 1);
  });

  await test('claim: un job ya terminal (sin reset) es noop_terminal y ni siquiera se reclama', async () => {
    const store = crearStoreFake({ job: { status: 'completed' } });
    const ctx = contexto();
    const ejecutar = crearEjecutar({});

    const r = await ejecutarPipelineTick(
      {},
      { fecha: FECHA, ...inyectables({ store, ejecutar, reloj: null, ...ctx }) }
    );

    assert.strictEqual(r.tick, 'noop_terminal');
    assert.strictEqual(r.job.status, 'completed');
    assert.strictEqual(store.log.reclamos, 0, 'no reclama un job terminal');
    assert.strictEqual(ejecutar.llamadas.length, 0);
  });

  await test('heartbeat: un tick con exito reclama, hace checkpoints y libera el claim', async () => {
    const store = crearStoreFake();
    const ctx = contexto();
    const ejecutar = crearEjecutar({});

    const r = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        budgetMs: 10_000_000,
        staleMs: 123_456,
        maxLoops: 5,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar, reloj: null, ...ctx }),
      }
    );

    assert.strictEqual(r.tick, 'completed');
    assert.strictEqual(store.log.reclamos, 1);
    assert.strictEqual(store.log.ultimoReclamo.staleMs, 123_456, 'reclamar recibe el staleMs configurado');
    assert(store.log.ultimoReclamo.now instanceof Date, 'reclamar recibe un now Date');
    assert(store.log.guardados.length > 3, 'multiples checkpoints renuevan el heartbeat');
    assert.strictEqual(store.log.liberado, true);
  });

  await test('reset: reabre un job fallido, limpia flags de bloqueo y completa', async () => {
    const store = crearStoreFake({
      job: {
        status: 'failed',
        error_msg: 'clasificar reventó',
        stages_json: {
          scrapers: { status: 'completed', attempts: 1 },
          cotejar_listados_oficiales: { status: 'completed', attempts: 1 },
          reparar_pendientes_ia: { status: 'completed', attempts: 1 },
          // Quedó abortada Y bloqueada: sin limpiar el flag, re-abortaría al instante.
          clasificar: { status: 'aborted', attempts: 0, loops: 3, total: 15, bloqueado: true },
        },
      },
    });
    const ctx = contexto();
    const ejecutar = crearEjecutar({}); // clasificar ahora devuelve cola vacia -> completa

    const r = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        reset: true,
        budgetMs: 10_000_000,
        maxLoops: 5,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar, reloj: null, ...ctx }),
      }
    );

    assert.strictEqual(store.log.reabierto, true, 'un job terminal + reset debe reabrirse');
    assert.strictEqual(r.tick, 'completed');
    assert.strictEqual(store.job.stages_json.clasificar.status, 'completed', 'clasificar completa, no re-aborta');
    assert(!('bloqueado' in store.job.stages_json.clasificar), 'el flag bloqueado se limpia en el reset');
    // Las fases previas ya completadas no se repiten.
    assert(!ejecutar.paths().includes('/scrape-test-oficial'), 'scrapers ya completado no se repite');
    // clasificar SI se re-ejecuta.
    assert(ejecutar.paths().includes('/alertas/clasificar'), 'clasificar se reintenta tras el reset');
  });

  await test('reset reabre un job running con el heartbeat rancio (claim colgado tras un corte)', async () => {
    const store = crearStoreFake({
      job: {
        status: 'running',
        claimed_by: 'tick-muerto',
        heartbeat_at: new Date(0).toISOString(), // epoch: rancio frente a cualquier now > staleMs
        stages_json: { scrapers: { status: 'completed', attempts: 1 } },
      },
    });
    const ctx = contexto();
    const ejecutar = crearEjecutar({});
    const reloj = crearReloj(10 * 60 * 1000); // now = 10 min => heartbeat rancio con staleMs de 5 min

    const r = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        reset: true,
        staleMs: 5 * 60 * 1000,
        budgetMs: 10_000_000,
        maxLoops: 5,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar, reloj, ...ctx }),
      }
    );

    assert.strictEqual(store.log.reabierto, true, 'un running con heartbeat rancio + reset debe reabrirse');
    assert.strictEqual(r.tick, 'completed');
    assert.strictEqual(r.recovery.reason, 'heartbeat_stale');
    assert(r.recovery.previous_job.claimed_by === 'tick-muerto', 'audita el job anterior');
    assert(r.recovery.new_claim.tick_id, 'audita el nuevo claim');
    assert.strictEqual(r.recovery.initial_stage, 'cotejar_listados_oficiales');
    assert.strictEqual(r.recovery.final.status, 'completed');
    // La fase ya completada no se repite tras el reset.
    assert(!ejecutar.paths().includes('/scrape-test-oficial'), 'no repite scrapers ya completado');
  });

  await test('un tick nuevo toma automaticamente un stale sin reset y lo completa', async () => {
    const store = crearStoreFake({
      job: {
        status: 'running',
        claimed_by: 'tick-muerto',
        heartbeat_at: null,
        updated_at: new Date(0).toISOString(),
        stages_json: { scrapers: { status: 'completed', attempts: 1 } },
      },
    });
    const result = await ejecutarPipelineTick({}, {
      fecha: FECHA,
      staleMs: 5 * 60 * 1000,
      budgetMs: 10_000_000,
      stepDelayMs: 0,
      ...inyectables({
        store,
        ejecutar: crearEjecutar({}),
        reloj: crearReloj(10 * 60 * 1000),
        ...contexto(),
      }),
    });
    assert.strictEqual(store.log.reabierto, false, 'no necesita reset manual');
    assert.strictEqual(result.tick, 'completed');
    assert.strictEqual(result.recovery.reason, 'heartbeat_missing');
    assert.strictEqual(result.recovery.action, 'claim_takeover');
    assert.strictEqual(result.recovery.final.status, 'completed');
  });

  await test('reset NO reabre un running con heartbeat fresco (no pisa un tick vivo)', async () => {
    const store = crearStoreFake({
      job: { status: 'running', claimed_by: 'tick-vivo', heartbeat_at: new Date(9 * 60 * 1000).toISOString() },
      reclamarDevuelveNull: true, // el tick vivo tiene el claim: reclamar falla
    });
    const ctx = contexto();
    const ejecutar = crearEjecutar({});
    const reloj = crearReloj(10 * 60 * 1000); // now - heartbeat = 1 min < staleMs 5 min => fresco

    const r = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        reset: true,
        staleMs: 5 * 60 * 1000,
        ...inyectables({ store, ejecutar, reloj, ...ctx }),
      }
    );

    assert.strictEqual(store.log.reabierto, false, 'un running fresco NO se reabre aunque venga reset');
    assert.strictEqual(r.tick, 'already_running');
    assert.strictEqual(ejecutar.llamadas.length, 0, 'no ejecuta ninguna fase');
  });

  await test('la reserva de presupuesto frena antes de arrancar una request que no cabe', async () => {
    const store = crearStoreFake();
    const ctx = contexto();
    const reloj = crearReloj(0);
    const ejecutar = crearEjecutar({ reloj, avanceMs: 30 }); // cada llamada consume 30ms

    const r = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        budgetMs: 100,
        reservaMs: 50, // no arranca nada si quedan < 50ms hasta el deadline
        maxLoops: 5,
        stepDelayMs: 0,
        ...inyectables({ store, ejecutar, reloj, ...ctx }),
      }
    );

    // scrapers(omitido, t=0) -> cotejar(t=30) -> reparar(t=60) -> clasificar: 60+50 >= 100 => pausa
    assert.strictEqual(r.tick, 'budget_exhausted');
    assert.strictEqual(r.job.current_stage, 'clasificar', 'para en clasificar por la reserva, no la arranca');
  });

  await test('crearEjecutorHttp: aborta y no cuelga cuando una request supera el timeout', async () => {
    const originalFetch = global.fetch;
    // fetch que solo termina si se aborta su signal (imita una fuente colgada).
    global.fetch = (_url, opts) =>
      new Promise((_resolve, reject) => {
        const signal = opts && opts.signal;
        const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        if (signal) {
          if (signal.aborted) return fail();
          signal.addEventListener('abort', fail);
        }
      });

    try {
      const ejecutar = crearEjecutorHttp({
        baseUrl: 'http://api.test',
        token: 'x',
        fecha: FECHA,
        httpRetries: 0,
        httpTimeoutMs: 20,
      });
      await assert.rejects(() => ejecutar('/alertas/clasificar'), /timeout tras 20ms/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  // --- Preflight de la base URL interna ---------------------------------------

  console.log('\n--- preflight base URL interna ---\n');

  await test('preflight fallido: devuelve preflight_failed sin crear ni reclamar el job', async () => {
    const store = crearStoreFake();
    const r = await ejecutarPipelineTick(
      {},
      {
        fecha: FECHA,
        store,
        preflight: async () => ({ ok: false, error: 'no responde: sin respuesta tras 5000ms' }),
      }
    );

    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.tick, 'preflight_failed');
    assert(/no responde/.test(r.error), 'el motivo del preflight debe llegar en la respuesta');
    assert.strictEqual(store.log.reclamos, 0, 'no debe reclamar el job');
    assert.strictEqual(store.log.guardados.length, 0, 'no debe escribir checkpoints');
    assert.strictEqual(store.job.status, 'pending', 'el job no debe cambiar de estado');
  });

  await test('verificarBaseUrlInterna: ok cuando /health responde 200', async () => {
    const urls = [];
    const salud = await verificarBaseUrlInterna('https://api.example.com', {
      timeoutMs: 1000,
      fetchImpl: async (url) => {
        urls.push(url);
        return { ok: true, status: 200 };
      },
    });
    assert.strictEqual(salud.ok, true);
    assert.deepStrictEqual(urls, ['https://api.example.com/health']);
  });

  await test('verificarBaseUrlInterna: un host que nunca responde corta por timeout', async () => {
    const salud = await verificarBaseUrlInterna('https://colgado.example.com', {
      timeoutMs: 30,
      // Imita el fetch real: solo termina cuando se aborta via signal.
      fetchImpl: (url, { signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        });
      }),
    });
    assert.strictEqual(salud.ok, false);
    assert(/sin respuesta tras 30ms/.test(salud.error), `motivo inesperado: ${salud.error}`);
  });

  await test('verificarBaseUrlInterna: base URL vacia falla sin llamar a fetch', async () => {
    let llamado = false;
    const salud = await verificarBaseUrlInterna('', { fetchImpl: async () => { llamado = true; } });
    assert.strictEqual(salud.ok, false);
    assert.strictEqual(llamado, false);
  });

  // --- Store real (crearPipelineJobsStore) contra un fake de supabase ---------

  console.log('\n--- pipelineJobs store (claim atomico) ---\n');

  await test('store.reclamar devuelve la fila cuando el claim atomico afecta a una fila', async () => {
    const supabase = fakeSupabase({ data: [{ id: 7, status: 'running', options_json: {}, stages_json: {} }], error: null });
    const store = crearPipelineJobsStore(supabase);
    const claimed = await store.reclamar({ job: { id: 7, ticks: 0 }, tickId: 'abc', staleMs: 1000, now: new Date() });
    assert(claimed && claimed.id === 7, 'devuelve la fila reclamada');
    const metodos = supabase.calls.map((c) => c.method);
    for (const m of ['update', 'eq', 'in', 'or', 'select']) {
      assert(metodos.includes(m), `reclamar usa .${m}()`);
    }
    const update = supabase.calls.find((c) => c.method === 'update');
    assert(update.args[0].claimed_by === 'abc' && update.args[0].heartbeat_at, 'toma el claim y sella heartbeat');
    const orFilter = supabase.calls.find((c) => c.method === 'or');
    assert(
      orFilter.args[0].includes('heartbeat_at.is.null'),
      'un job legacy sin heartbeat tambien puede recuperarse'
    );
  });

  await test('diagnostica el residual running sin current_stage ni heartbeat como stale recuperable', async () => {
    const diagnostic = diagnosticarPipelineJob({
      id: 77,
      status: 'running',
      current_stage: null,
      heartbeat_at: null,
      claimed_by: 'tick-antiguo',
    }, { now: new Date('2026-07-21T10:00:00.000Z'), staleMs: 5 * 60 * 1000 });
    assert.strictEqual(diagnostic.stale, true);
    assert.strictEqual(diagnostic.recoverable, true);
    assert(diagnostic.flags.includes('current_stage_missing'));
    assert(diagnostic.flags.includes('heartbeat_missing'));
  });

  await test('store.reclamar audita takeover stale y permite current_stage null antiguo', async () => {
    const now = new Date('2026-07-22T12:00:00.000Z');
    const staleJob = {
      id: 78,
      kind: 'daily',
      fecha: '2026-07-18',
      shadow: true,
      status: 'running',
      current_stage: null,
      claimed_by: 'tick-muerto',
      heartbeat_at: '2026-07-22T11:59:00.000Z',
      updated_at: '2026-07-22T11:00:00.000Z',
      options_json: {},
      ticks: 1,
    };
    const supabase = fakeSupabase({ data: [{ ...staleJob, claimed_by: 'nuevo-tick' }], error: null });
    const store = crearPipelineJobsStore(supabase);
    await store.reclamar({ job: staleJob, tickId: 'nuevo-tick', staleMs: 5 * 60 * 1000, now });
    const update = supabase.calls.find((call) => call.method === 'update').args[0];
    const event = update.options_json.recovery_audit[0];
    assert.strictEqual(event.reason, 'current_stage_missing_too_long');
    assert.strictEqual(event.previous_job.claimed_by, 'tick-muerto');
    assert.strictEqual(event.new_claim.tick_id, 'nuevo-tick');
    const orFilter = supabase.calls.find((call) => call.method === 'or').args[0];
    assert(orFilter.includes('and(current_stage.is.null,updated_at.lt.'));
  });

  await test('store.reclamar devuelve null cuando otro tick lo tiene (0 filas)', async () => {
    const supabase = fakeSupabase({ data: [], error: null });
    const store = crearPipelineJobsStore(supabase);
    const claimed = await store.reclamar({ job: { id: 7 }, tickId: 'abc', staleMs: 1000, now: new Date() });
    assert.strictEqual(claimed, null);
  });

  await test('store.guardar lanza pipeline_job_claim_perdido si el update no toca filas', async () => {
    const supabase = fakeSupabase({ data: [], error: null });
    const store = crearPipelineJobsStore(supabase);
    await assert.rejects(
      () => store.guardar({ jobId: 7, tickId: 'abc', patch: { current_stage: 'clasificar' } }),
      /pipeline_job_claim_perdido/
    );
  });

  await test('store.obtenerOCrear devuelve el job existente sin insertar', async () => {
    const supabase = fakeSupabase({ data: { id: 9, kind: 'daily', fecha: FECHA, shadow: false, status: 'pending' }, error: null });
    const store = crearPipelineJobsStore(supabase);
    const job = await store.obtenerOCrear({ kind: 'daily', fecha: FECHA, shadow: false });
    assert.strictEqual(job.id, 9);
    assert(!supabase.calls.some((c) => c.method === 'insert'), 'no inserta si ya existe');
  });

  await test('store.reabrir pone el job en pending y limpia finished_at/claim', async () => {
    const supabase = fakeSupabase({ data: { id: 9, status: 'pending', finished_at: null, claimed_by: null }, error: null });
    const store = crearPipelineJobsStore(supabase);
    const job = await store.reabrir({ jobId: 9 });
    assert.strictEqual(job.status, 'pending');
    const update = supabase.calls.find((c) => c.method === 'update');
    assert.strictEqual(update.args[0].status, 'pending');
    assert.strictEqual(update.args[0].finished_at, null);
    assert.strictEqual(update.args[0].claimed_by, null);
  });

  await test('store.abortar cierra explicitamente un stale con auditoria', async () => {
    const previous = {
      id: 10,
      shadow: true,
      status: 'running',
      claimed_by: 'tick-muerto',
      options_json: {},
    };
    const supabase = fakeSupabase({ data: [{ ...previous, status: 'aborted' }], error: null });
    const store = crearPipelineJobsStore(supabase);
    const job = await store.abortar({
      job: previous,
      reason: 'heartbeat_missing',
      now: new Date('2026-07-22T12:00:00.000Z'),
    });
    assert.strictEqual(job.status, 'aborted');
    const patch = supabase.calls.find((call) => call.method === 'update').args[0];
    assert.strictEqual(patch.finished_at, '2026-07-22T12:00:00.000Z');
    assert.strictEqual(patch.options_json.recovery_audit[0].final.status, 'aborted');
  });

  console.log(`\nResultados pipelineRunner: ${passed} aprobados, ${failed} fallidos`);
  if (failed > 0) process.exit(1);
}

// Mock encadenable de supabase: cualquier metodo devuelve el builder; al hacer
// await se resuelve con el resultado configurado (los builders de supabase-js
// son thenables). Igual patron que scraperSkip.test.js, ampliado con los
// metodos que usa el store de pipeline_jobs.
function fakeSupabase(result) {
  const calls = [];
  const builder = {};
  for (const method of ['select', 'insert', 'update', 'eq', 'in', 'or', 'order', 'limit', 'maybeSingle', 'single']) {
    builder[method] = (...args) => {
      calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve) => resolve(result);
  return {
    calls,
    from(table) {
      calls.push({ method: 'from', args: [table] });
      return builder;
    },
  };
}

main();
