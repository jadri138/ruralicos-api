// src/modules/boletines/fuentesHealth.js
//
// Salud de las fuentes de boletines a partir del historial de scraper_runs.
//
// Motivación: BOPZ y BOCCE estuvieron 7+ días fallando el 100% de las
// ejecuciones sin que nadie lo detectara, porque los warnings ruidosos
// ahogaban a los errores reales. Este módulo detecta fuentes "caídas"
// (todos los runs de un día en error, durante N días consecutivos) para
// avisar al admin por WhatsApp desde /tareas/salud-fuentes.

// runs: [{ fuente, dia: 'YYYY-MM-DD', status, error_msg }]
function evaluarSaludFuentes(runs, { minDiasCaida = 2 } = {}) {
  const porFuente = new Map();

  for (const run of runs || []) {
    const fuente = String(run.fuente || '').trim();
    const dia = String(run.dia || '').slice(0, 10);
    if (!fuente || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) continue;

    if (!porFuente.has(fuente)) porFuente.set(fuente, new Map());
    const dias = porFuente.get(fuente);
    if (!dias.has(dia)) dias.set(dia, { total: 0, errores: 0, ultimoError: null });

    const info = dias.get(dia);
    info.total += 1;
    if (run.status === 'error') {
      info.errores += 1;
      if (run.error_msg) info.ultimoError = String(run.error_msg).slice(0, 200);
    }
  }

  const caidas = [];

  for (const [fuente, dias] of porFuente) {
    // Días con ejecuciones, del más reciente al más antiguo.
    const ordenados = [...dias.keys()].sort().reverse();
    let consecutivos = 0;
    let ultimoError = null;

    for (const dia of ordenados) {
      const info = dias.get(dia);
      if (info.total > 0 && info.errores === info.total) {
        consecutivos += 1;
        if (!ultimoError) ultimoError = info.ultimoError;
      } else {
        break;
      }
    }

    if (consecutivos >= minDiasCaida) {
      caidas.push({
        fuente,
        dias_caida: consecutivos,
        ultimo_error: ultimoError,
      });
    }
  }

  return caidas.sort((a, b) => b.dias_caida - a.dias_caida || a.fuente.localeCompare(b.fuente));
}

function construirMensajeFuentesCaidas(caidas, { fecha } = {}) {
  if (!caidas?.length) return '';

  const lineas = [
    '*Ruralicos: fuentes de boletines caídas*',
    '',
    ...caidas.map((item) =>
      `• ${item.fuente}: ${item.dias_caida} día(s) con el 100% de ejecuciones en error` +
      (item.ultimo_error ? `\n  Último error: ${item.ultimo_error}` : '')
    ),
    '',
    `Revisado el ${fecha || new Date().toISOString().slice(0, 10)}. Detalle en el panel → Operaciones.`,
  ];

  return lineas.join('\n');
}

module.exports = {
  evaluarSaludFuentes,
  construirMensajeFuentesCaidas,
};
