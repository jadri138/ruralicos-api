#!/usr/bin/env node

/**
 * Responde a "¿por qué hoy no le llega nada a nadie?" sin enviar ni un mensaje.
 *
 * Reproduce el embudo real de un día —alertas del día, compuerta de calidad,
 * filtro por usuario y barreras duras del contrato canónico— y dice cuántas
 * personas recibirían algo y en qué barrera cae el resto.
 *
 * Sólo lee. No llama a OpenAI, no construye ni guarda fichas, no toca la cola
 * y no envía WhatsApp. Es seguro ejecutarlo con producción en marcha.
 *
 *   node scripts/diagnostico_cobertura_digest.js
 *   node scripts/diagnostico_cobertura_digest.js --fecha 2026-08-05
 *   node scripts/diagnostico_cobertura_digest.js --json
 *
 * Las fichas se leen tal y como están almacenadas. El workflow real construye
 * fichas que faltan, así que la cobertura real puede ser algo mayor que ésta:
 * este informe es un suelo, no un techo.
 */

require('dotenv').config();

const {
  cargarAlertasListasDigest,
  cargarUsuariosPagoDigest,
  filtrarAlertasPorCalidadDigest,
} = require('../src/modules/digest/digest.service');
const { filtrarAlertasParaDigest } = require('../src/modules/alertas/seleccion/alertSelectionEngine');
const { adaptAlertTruthCard } = require('../src/modules/alertas/decision/truthCard');
const { evaluateCandidateEligibility } = require('../src/modules/alertas/decision/candidatePipeline');
const { buildDecisionProfile } = require('../src/modules/alertas/decision/decisionProfile');

const FICHA_SELECT = [
  'alerta_id', 'fact_sheet', 'status', 'truth_score', 'risk_score',
  'evidence_coverage', 'flags', 'reasons', 'schema_version', 'builder_version',
  'content_hash',
].join(', ');

function valorArgumento(argv, nombre) {
  const indice = argv.indexOf(nombre);
  return indice >= 0 ? argv[indice + 1] : null;
}

function diaValido(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

// Lotes pequeños: la ficha completa es un JSON grande y pedir muchas de una vez
// alarga la URL y el cuerpo hasta hacer fallar la petición.
async function cargarFichasPorAlerta(supabase, ids = [], { tamanoLote = 50 } = {}) {
  const fichas = new Map();
  for (let i = 0; i < ids.length; i += tamanoLote) {
    const lote = ids.slice(i, i + tamanoLote);
    let ultimoError = null;
    for (let intento = 1; intento <= 3; intento += 1) {
      try {
        const { data, error } = await supabase
          .from('alert_fact_sheets')
          .select(FICHA_SELECT)
          .in('alerta_id', lote);
        if (error) throw new Error(error.message);
        for (const row of data || []) fichas.set(Number(row.alerta_id), row);
        ultimoError = null;
        break;
      } catch (error) {
        ultimoError = error;
        await new Promise((resolve) => setTimeout(resolve, 500 * intento));
      }
    }
    if (ultimoError) throw new Error(`alert_fact_sheets: ${ultimoError.message}`);
  }
  return fichas;
}

async function diagnosticarCoberturaDigest({ supabase, fecha, now = new Date() } = {}) {
  const { data: alertasDia, error } = await cargarAlertasListasDigest(supabase, { fecha });
  if (error) throw new Error(`alertas: ${error.message}`);

  const calidad = filtrarAlertasPorCalidadDigest(alertasDia || [], { minScore: 65 });
  const disponibles = calidad.aceptadas;
  const { data: usuarios, error: errorUsuarios } = await cargarUsuariosPagoDigest(supabase);
  if (errorUsuarios) throw new Error(`users: ${errorUsuarios.message}`);

  // Se calculan primero las candidatas de cada persona y sólo después se leen
  // las fichas que hacen falta: traer la ficha completa de todas las alertas
  // del día multiplica el tráfico sin aportar nada al informe.
  const candidatasPorUsuario = new Map();
  const sinCandidatas = [];
  const idsNecesarios = new Set();

  for (const user of usuarios || []) {
    const seleccion = filtrarAlertasParaDigest(disponibles, user, {
      qualityGate: true,
      allowReview: true,
      minReviewQualityScore: 78,
      allowIndividualWithoutMunicipio: true,
    });
    if (!seleccion.alertas.length) {
      sinCandidatas.push(user.id);
      continue;
    }
    candidatasPorUsuario.set(user, seleccion.alertas);
    for (const alerta of seleccion.alertas) idsNecesarios.add(alerta.id);
  }

  const fichas = await cargarFichasPorAlerta(supabase, [...idsNecesarios]);
  const bloqueos = new Map();
  const conAprobada = [];
  let parejas = 0;
  let aprobadas = 0;
  let sinFicha = 0;

  for (const [user, candidatas] of candidatasPorUsuario.entries()) {
    const profile = buildDecisionProfile({ user, now, pseudonymSalt: 'diagnostico' });
    let aprobadasUsuario = 0;

    for (const alerta of candidatas) {
      parejas += 1;
      const fila = fichas.get(Number(alerta.id));
      if (!fila) sinFicha += 1;
      const card = fila
        ? adaptAlertTruthCard({ ...fila, fact_sheet: fila.fact_sheet }, { legacyAlert: alerta })
        : adaptAlertTruthCard(alerta, { legacyAlert: alerta });
      const resultado = evaluateCandidateEligibility(
        { alert_id: alerta.id, truth_card: card, origins: [] },
        profile
      );
      if (resultado.eligible) {
        aprobadas += 1;
        aprobadasUsuario += 1;
        continue;
      }
      for (const code of resultado.reason_codes || ['SIN_MOTIVO']) {
        bloqueos.set(code, (bloqueos.get(code) || 0) + 1);
      }
    }

    if (aprobadasUsuario > 0) conAprobada.push(user.id);
  }

  return {
    fecha: fecha || 'hoy',
    alertas_del_dia: (alertasDia || []).length,
    tras_calidad: disponibles.length,
    rechazadas_calidad: calidad.rechazadas.length,
    usuarios: (usuarios || []).length,
    usuarios_sin_candidatas: sinCandidatas.length,
    usuarios_con_alerta_aprobada: conAprobada.length,
    parejas_evaluadas: parejas,
    parejas_aprobadas: aprobadas,
    parejas_sin_ficha: sinFicha,
    bloqueos: Object.fromEntries(
      [...bloqueos.entries()].sort((izq, der) => der[1] - izq[1])
    ),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const comoJson = argv.includes('--json');
  const fechaPedida = valorArgumento(argv, '--fecha');
  if (fechaPedida && !diaValido(fechaPedida)) {
    console.error('La fecha debe tener formato AAAA-MM-DD.');
    process.exitCode = 1;
    return;
  }

  const { supabase } = require('../src/platform/supabase');
  if (!comoJson) {
    console.log(
      `Reproduciendo el embudo de ${fechaPedida || 'hoy'} contra todas las personas de pago.`
    );
    console.log('Puede tardar unos minutos. No se envía nada ni se escribe en la base.\n');
  }
  const informe = await diagnosticarCoberturaDigest({
    supabase,
    fecha: fechaPedida || undefined,
  });

  if (comoJson) {
    console.log(JSON.stringify(informe, null, 2));
    return;
  }

  console.log(`Cobertura del digest (${informe.fecha})\n`);
  console.log(`Alertas del día:                  ${informe.alertas_del_dia}`);
  console.log(`  pasan la compuerta de calidad:  ${informe.tras_calidad}`);
  console.log(`  rechazadas por calidad:         ${informe.rechazadas_calidad}`);
  console.log('');
  console.log(`Personas de pago:                 ${informe.usuarios}`);
  console.log(`  sin ninguna candidata:          ${informe.usuarios_sin_candidatas}`);
  console.log(`  con al menos una aprobada:      ${informe.usuarios_con_alerta_aprobada}`);
  console.log('');
  console.log(`Parejas persona-alerta evaluadas: ${informe.parejas_evaluadas}`);
  console.log(`  aprobadas por las barreras:     ${informe.parejas_aprobadas}`);
  console.log(`  evaluadas sin ficha guardada:   ${informe.parejas_sin_ficha}`);

  const bloqueos = Object.entries(informe.bloqueos);
  if (bloqueos.length > 0) {
    console.log('\nDónde se queda el resto:');
    for (const [code, veces] of bloqueos) {
      console.log(`  ${String(veces).padStart(5)}  ${code}`);
    }
  }

  console.log(
    informe.usuarios_con_alerta_aprobada > 0
      ? `\nHoy habría material para ${informe.usuarios_con_alerta_aprobada} personas.`
      : '\nHoy no hay ninguna alerta que supere las barreras: el silencio sería correcto.'
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`No se pudo diagnosticar: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { diagnosticarCoberturaDigest };
