// Helper de captura bruta para scrapers que PRE-clasifican dentro del propio
// scraper (patrón "listar todo → filtrar por título/contexto → traer texto solo de
// los relevantes": DOG, DOGC, DOGV, BOR, BOPV, BOPA, BON, BOME, BOIB, BOCM, BOCCE,
// BOCANT, BOCAN y provinciales).
//
// Esos scrapers devuelven TODOS los documentos detectados y adjuntan una decisión
// `_prefiltro_rural`. Aquí se registran TODOS en raw_documents: solo discard queda
// `skipped_by_rule`; pass y review pasan a insertarAlertasBoletin.
//
// No usa IA, no descarga nada extra y no cambia el comportamiento de `alertas`.
//
// Compat: un documento booleano sin decisión estructurada sigue usando
// `_relevante`; si no trae ninguno de los dos campos se considera insertable.

const { insertarAlertasBoletin } = require('./insertarAlertasBoletin');
const {
  registrarRawDocuments,
  marcarRawDocumentSaltado,
} = require('../../rawDocuments/rawDocuments.service');
const { PREFILTER_ACTION } = require('../../scrapers/shared/ruralFilter');

async function procesarBoletinPreclasificado(supabase, docs, opciones) {
  const {
    fuente,
    region,
    contenido,
    motivoFiltro = 'rural_filter_no_match',
  } = opciones;

  const lista = Array.isArray(docs) ? docs : [];

  // 1) Registrar TODO lo detectado en raw_documents (cada doc recibe raw_document_id).
  const docsConRaw = await registrarRawDocuments(supabase, lista, { fuente, region });

  // 2) Solo discard se salta. El booleano _relevante se conserva como
  // compatibilidad con scrapers antiguos; las rutas actuales adjuntan la
  // decisión estructurada en _prefiltro_rural.
  let saltadasFiltro = 0;
  const insertables = [];
  const prefiltro = { pass: 0, review: 0, discard: 0 };
  for (const doc of docsConRaw) {
    const action = doc._prefiltro_rural?.action
      || (doc._relevante === false ? PREFILTER_ACTION.DISCARD : PREFILTER_ACTION.PASS);
    prefiltro[action] += 1;

    if (action === PREFILTER_ACTION.DISCARD) {
      saltadasFiltro += 1;
      await marcarRawDocumentSaltado(supabase, doc.raw_document_id, motivoFiltro);
      continue;
    }
    insertables.push(doc);
  }

  // 3) Insertar el resto; insertarAlertasBoletin enlaza inserted/duplicate/missing_url.
  const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(
    supabase,
    insertables,
    { fuente, region, contenido }
  );

  return {
    totales: lista.length,
    documentos_insertables: insertables.length,
    nuevas,
    duplicadas,
    errores,
    saltadasFiltro,
    prefiltro,
  };
}

module.exports = { procesarBoletinPreclasificado };
