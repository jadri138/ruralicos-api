#!/usr/bin/env node

/**
 * Comprueba si el esquema remoto tiene ya el contrato de decisión y entrega.
 *
 * Es el paso previo al despliegue: la API nueva escribe estados, embudo,
 * idempotencia y ACK que sólo existen tras aplicar
 * `20260801211224_alert_decision_delivery_contracts.sql`. Desplegar antes de
 * esa migración deja el flujo escribiendo columnas inexistentes.
 *
 * Sólo lee. No inserta, no actualiza, no envía y no imprime credenciales.
 *
 *   node scripts/check_decision_schema.js
 *   node scripts/check_decision_schema.js --json
 *
 * Devuelve 0 si el esquema está completo y 1 si falta algo o no se pudo
 * comprobar. Un fallo de credencial no se informa como "esquema incompleto".
 */

require('dotenv').config();

// Columnas que el código nuevo necesita para funcionar, agrupadas por tabla.
const CONTRATO_ESPERADO = Object.freeze([
  ['digest_candidate_decisions', [
    'decision_state', 'contract_version', 'policy_version', 'judge_version',
    'prompt_version', 'reason_codes', 'input_hash', 'llm_model', 'llm_usage',
    'llm_cost', 'llm_calls', 'cache_hit', 'fallback_reason', 'decided_at',
    'hold_status', 'hold_attempts', 'hold_next_at', 'hold_last_at',
    'hold_claim_token', 'hold_claimed_at', 'hold_resolution_json',
  ]],
  ['digest_attempts', [
    'judge_evaluated_count', 'approved_count', 'queued_count',
    'delivered_count', 'delivery_status', 'metadata_json',
  ]],
  ['digests', ['delivery_status', 'idempotency_key', 'message_version', 'provider_message_id']],
  ['mia_outbox', ['delivery_status', 'idempotency_key', 'provider_message_id']],
  ['whatsapp_logs', ['delivery_status', 'provider_message_id', 'idempotency_key']],
  ['whatsapp_delivery_events', [
    'id', 'event_hash', 'idempotency_key', 'outbox_id', 'digest_id', 'user_id',
    'provider_message_id', 'provider_status', 'delivery_status', 'event_at',
    'payload_json', 'processed_at',
  ]],
  ['user_memory', [
    'memory_key', 'scope_type', 'scope_value', 'polarity', 'source', 'strength',
    'confidence', 'status', 'expires_at', 'correction_of', 'duplicate_count',
    'last_seen_at',
  ]],
  ['alert_fact_sheets', [
    'recovery_status', 'recovery_attempts', 'recovery_next_at',
    'recovery_strategy', 'recovery_missing_fields',
  ]],
  // La clave primaria es `fecha`: esta tabla no tiene columna `id`.
  ['alert_decision_llm_daily_budget', ['fecha', 'call_limit', 'reserved_calls', 'updated_at']],
]);

const TABLA_AUSENTE = /relation .* does not exist|Could not find the table/i;
const COLUMNA_AUSENTE = /column .* does not exist|Could not find the '.*' column|does not exist/i;
const CREDENCIAL_INVALIDA = /Invalid API key|JWT|api key|unauthorized/i;

class CredencialError extends Error {}

async function comprobarColumna(client, tabla, columna) {
  const { error } = await client.from(tabla).select(columna).limit(1);
  if (!error) return { ok: true };

  const mensaje = String(error.message || '');
  if (CREDENCIAL_INVALIDA.test(mensaje)) throw new CredencialError(mensaje);
  if (TABLA_AUSENTE.test(mensaje)) return { ok: false, tablaAusente: true, mensaje };
  if (COLUMNA_AUSENTE.test(mensaje)) return { ok: false, mensaje };
  // Un error distinto no demuestra que falte la columna: se informa aparte
  // para no dar por incompleto un esquema que quizá está bien.
  return { ok: false, indeterminado: true, mensaje };
}

async function comprobarEsquemaDecision({ client, contrato = CONTRATO_ESPERADO } = {}) {
  const supabase = client || require('../src/platform/supabase').supabase;
  const tablas = [];

  for (const [tabla, columnas] of contrato) {
    const ausentes = [];
    const indeterminadas = [];
    let tablaAusente = false;

    for (const columna of columnas) {
      const resultado = await comprobarColumna(supabase, tabla, columna);
      if (resultado.ok) continue;
      if (resultado.tablaAusente) { tablaAusente = true; break; }
      if (resultado.indeterminado) indeterminadas.push({ columna, motivo: resultado.mensaje });
      else ausentes.push(columna);
    }

    // Un error que no sabemos interpretar no autoriza a decir "esta aplicada":
    // se marca indeterminado y el informe no da luz verde.
    const estado = tablaAusente
      ? 'tabla_ausente'
      : ausentes.length
        ? 'columnas_ausentes'
        : indeterminadas.length
          ? 'indeterminado'
          : 'ok';

    tablas.push({
      tabla,
      estado,
      columnas_esperadas: columnas.length,
      columnas_ausentes: ausentes,
      indeterminadas,
    });
  }

  const incompletas = tablas.filter((row) => row.estado !== 'ok');
  return {
    contract_version: 'alert_decision_delivery_contracts_v1',
    aplicada: incompletas.length === 0,
    tablas,
    resumen: {
      completas: tablas.length - incompletas.length,
      incompletas: incompletas.length,
      indeterminadas: tablas.filter((row) => row.indeterminadas.length > 0).length,
    },
  };
}

async function main() {
  const comoJson = process.argv.includes('--json');
  let informe;

  try {
    informe = await comprobarEsquemaDecision({});
  } catch (error) {
    const credencial = error instanceof CredencialError;
    const mensaje = credencial
      ? 'La credencial de Supabase no es válida: no se pudo comprobar el esquema. Esto NO significa que la migración falte.'
      : `No se pudo comprobar el esquema: ${error.message}`;
    if (comoJson) console.log(JSON.stringify({ ok: false, motivo: credencial ? 'credencial_invalida' : 'error', mensaje }, null, 2));
    else console.error(mensaje);
    process.exitCode = 1;
    return;
  }

  if (comoJson) {
    console.log(JSON.stringify(informe, null, 2));
  } else {
    console.log('Contrato de decisión y entrega en el esquema remoto\n');
    for (const fila of informe.tablas) {
      if (fila.estado === 'ok') {
        console.log(`OK            ${fila.tabla} (${fila.columnas_esperadas} columnas)`);
      } else if (fila.estado === 'tabla_ausente') {
        console.log(`FALTA TABLA   ${fila.tabla}`);
      } else if (fila.estado === 'indeterminado') {
        console.log(`SIN COMPROBAR ${fila.tabla}`);
      } else {
        console.log(`FALTAN COLS   ${fila.tabla}: ${fila.columnas_ausentes.join(', ')}`);
      }
      for (const dudosa of fila.indeterminadas) {
        console.log(`  ? ${dudosa.columna}: ${dudosa.motivo.slice(0, 100)}`);
      }
    }
    console.log('');
    if (informe.aplicada) {
      console.log('La migración del contrato está aplicada. Se puede desplegar la API.');
    } else if (informe.resumen.indeterminadas > 0 && informe.resumen.incompletas === informe.resumen.indeterminadas) {
      console.log('No se pudo comprobar todo el esquema. Revisa el motivo antes de desplegar.');
    } else {
      console.log('Faltan objetos: aplica la migración ANTES de desplegar la API nueva.');
    }
  }

  process.exitCode = informe.aplicada ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`No se pudo comprobar el esquema: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { CONTRATO_ESPERADO, CredencialError, comprobarEsquemaDecision };
