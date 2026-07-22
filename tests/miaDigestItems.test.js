const { construirDigestItems } = require('../src/modules/mia/digestItems');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

console.log('\n=== TESTS: mia digest items ===\n');

const rows = construirDigestItems({
  digestId: 10,
  userId: 141,
  fecha: '2026-05-22',
  origen: 'pgvector_rpc',
  organizationId: 12,
  alertas: [
    {
      id: 8064,
      titulo: 'Ayudas para maquinaria agricola',
      resumen_final: 'Convocatoria para tractores.',
      similitud: 0.82,
      provincias: ['Aragon'],
      sectores: ['Agricultura'],
      tipos_alerta: ['ayudas_subvenciones'],
      fuente: 'BOA',
      decision_digest: {
        incluir: true,
        action: 'include',
        motivo: 'incluida',
        riesgo: 'bajo',
        score: 91,
        match_trace: {
          territory_match: 'national',
          sector_match: 'agricultura',
          subsector_match: null,
          type_match: 'ayudas_subvenciones',
          score: 91,
          decision: 'include',
        },
      },
      motivo_seleccion_mia: 'pgvector_rpc:incluida:score_91:riesgo_bajo',
      mia_profile_score: 2.5,
      mia_profile_reasons: ['interest:ayudas_maquinaria:2.50'],
      grupo_digest: 'Ayudas',
      grupo_digest_key: 'ayudas',
      relevancia_digest: 'Alta',
      relevancia_digest_key: 'alta',
      fact_sheet_status: 'ready_for_digest',
      truth_score: 96,
      risk_score: 8,
      evidence_coverage: 0.92,
      final_validation_status: 'send',
      final_validation_flags: [],
      final_validation_reasons: [],
      effective_send_gate: {
        selection_decision: { action: 'include', incluir: true, score: 91 },
        final_validation_decision: { status: 'send', flags: [], reasons: [] },
        effective_send_decision: 'send',
        effective_reason: 'automatic_send_allowed',
        automatic_send_allowed: true,
        gate_version: 'final_send_gate_v1',
        context: 'automatic_daily',
      },
      shadow_decision: {
        version: 'digest_shadow_v1',
        future_decision: 'include',
      },
      contexto_mia_digest: {
        version: 'digest_context_v1',
        motivo_usuario: 'Coincide con sector: agricultura; tipo: ayudas_subvenciones.',
        mensaje: {
          titulo_facil: 'Ayudas para maquinaria',
          resumen_facil: 'Es una ayuda para maquinaria agrícola.',
          accion_sugerida: 'Mira requisitos y plazo.',
        },
      },
    },
  ],
});

assert(rows.length === 1, 'Construye una fila por alerta del digest');
assert(rows[0].item_numero === 1, 'Numera items desde 1');
assert(rows[0].alerta_id === 8064, 'Conserva alerta_id');
assert(rows[0].score === 91, 'Guarda score final del motor cuando existe');
assert(rows[0].selection_score === 91, 'Guarda score de seleccion en columna dedicada');
assert(rows[0].selection_action === 'include', 'Guarda accion de seleccion');
assert(rows[0].selection_reason === 'incluida', 'Guarda motivo de seleccion');
assert(rows[0].selection_risk === 'bajo', 'Guarda riesgo de seleccion');
assert(rows[0].similarity_score === 0.82, 'Guarda similitud en columna dedicada');
assert(rows[0].selection_decision.score === 91, 'Guarda decision completa en columna dedicada');
assert(rows[0].selection_decision.match_trace.territory_match === 'national', 'Guarda trazabilidad territorial del matching');
assert(rows[0].selection_decision.match_trace.sector_match === 'agricultura', 'Guarda trazabilidad sectorial del matching');
assert(rows[0].selection_decision.match_trace.type_match === 'ayudas_subvenciones', 'Guarda trazabilidad del tipo de alerta');
assert(rows[0].motivo_seleccion === 'pgvector_rpc:incluida:score_91:riesgo_bajo', 'No duplica origen si el motivo ya viene auditado');
assert(rows[0].organization_id === 12, 'Propaga organization_id al item del digest');
assert(rows[0].tags_json.fuente === 'BOA', 'Guarda tags de trazabilidad');
assert(rows[0].tags_json.decision_digest.riesgo === 'bajo', 'Guarda decision de inclusion en tags_json');
assert(rows[0].tags_json.selection.score === 91, 'Guarda auditoria normalizada de seleccion');
assert(rows[0].tags_json.selection.score_source === 'selection_engine', 'Marca origen del score del motor');
assert(rows[0].tags_json.similitud === 0.82, 'Conserva similitud vectorial separada del score');
assert(rows[0].tags_json.mia_profile_score === 2.5, 'Guarda score de perfil MIA');
assert(rows[0].tags_json.mia_profile_reasons[0] === 'interest:ayudas_maquinaria:2.50', 'Guarda razones de perfil MIA');
assert(rows[0].tags_json.grupo_digest === 'Ayudas', 'Guarda grupo visible del digest');
assert(rows[0].tags_json.relevancia_digest === 'Alta', 'Guarda relevancia visible del digest');
assert(rows[0].tags_json.fact_sheet_status === 'ready_for_digest', 'Guarda estado de fact sheet en tags_json');
assert(rows[0].tags_json.truth_score === 96, 'Guarda truth_score de fact sheet');
assert(rows[0].tags_json.risk_score === 8, 'Guarda risk_score de fact sheet');
assert(rows[0].tags_json.evidence_coverage === 0.92, 'Guarda cobertura de evidencia');
assert(rows[0].tags_json.final_validation_status === 'send', 'Guarda estado de validacion final');
assert(rows[0].tags_json.final_validation_decision.status === 'send', 'Guarda decision final estructurada');
assert(rows[0].tags_json.effective_send_decision === 'send', 'Guarda decision efectiva de envio');
assert(rows[0].tags_json.effective_reason === 'automatic_send_allowed', 'Guarda motivo efectivo');
assert(rows[0].tags_json.effective_gate_version === 'final_send_gate_v1', 'Guarda version del gate final');
assert(rows[0].tags_json.automatic_send_allowed === true, 'Solo send registra permiso automatico');
assert(rows[0].tags_json.shadow_decision.future_decision === 'include', 'Guarda decision shadow');
assert(rows[0].tags_json.contexto_mia_digest.version === 'digest_context_v1', 'Guarda contexto interno para MIA');
assert(rows[0].tags_json.contexto_mia_digest.mensaje.accion_sugerida.includes('plazo'), 'Guarda accion interna por alerta');
assert(/tractores/i.test(rows[0].resumen_usado), 'Guarda resumen usado para MIA');

const fallbackRows = construirDigestItems({
  digestId: 11,
  userId: 141,
  fecha: '2026-05-22',
  alertas: [{ id: 9001, titulo: 'Alerta sin decision explicita', similitud: 0.44 }],
});

assert(fallbackRows[0].score === 0.44, 'Usa similitud como fallback si no hay score de motor');
assert(fallbackRows[0].selection_score === null, 'No inventa score de seleccion sin decision_digest');
assert(fallbackRows[0].similarity_score === 0.44, 'Mantiene similitud cuando actua como fallback');
assert(Object.keys(fallbackRows[0].selection_decision).length === 0, 'Guarda decision vacia si no existe decision_digest');
assert(fallbackRows[0].tags_json.selection === null, 'No inventa decision si falta decision_digest');
assert(fallbackRows[0].tags_json.automatic_send_allowed === false, 'Sin gate efectivo persiste fail-closed');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
