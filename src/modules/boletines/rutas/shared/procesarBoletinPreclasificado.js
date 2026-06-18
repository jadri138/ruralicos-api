// Helper de captura bruta para scrapers que PRE-clasifican dentro del propio
// scraper (patrón "listar todo → filtrar por título/contexto → traer texto solo de
// los relevantes": DOG, DOGC, DOGV, BOR, BOPV, BOPA, BON, BOME, BOIB, BOCM, BOCCE,
// BOCANT, BOCAN y provinciales).
//
// Esos scrapers ahora devuelven TODOS los documentos detectados, cada uno anotado
// con `_relevante` (true/false). Aquí se registran TODOS en raw_documents ANTES de
// nada (ningún documento desaparece), los no relevantes quedan `skipped_by_rule`
// (auditados, no perdidos) y los relevantes pasan por insertarAlertasBoletin (que
// enlaza inserted / duplicate / missing_url).
//
// No usa IA, no descarga nada extra y no cambia el comportamiento de `alertas`.
//
// Compat: un documento sin `_relevante` (o con `_relevante === true`) se considera
// insertable, así que un scraper que aún no anote sigue funcionando igual que antes.

const { insertarAlertasBoletin } = require('./insertarAlertasBoletin');
const {
  registrarRawDocuments,
  marcarRawDocumentSaltado,
} = require('../../rawDocuments/rawDocuments.service');

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

  // 2) Los no relevantes (pre-clasificados en el scraper) -> skipped_by_rule.
  let saltadasFiltro = 0;
  const insertables = [];
  for (const doc of docsConRaw) {
    if (doc._relevante === false) {
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
  };
}

module.exports = { procesarBoletinPreclasificado };
