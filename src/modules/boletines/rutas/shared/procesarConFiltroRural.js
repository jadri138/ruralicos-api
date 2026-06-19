// Helper compartido de captura bruta auditable para scrapers que filtran EN LA
// RUTA (patrón BOJA): registra TODOS los documentos detectados en raw_documents
// ANTES de filtrar, aplica el filtro rural como preclasificación barata (los
// descartados quedan `skipped_by_rule`, no se pierden) e inserta el resto con
// insertarAlertasBoletin (que enlaza inserted/duplicate/missing_url).
//
// No usa IA, no descarga nada extra y no cambia el comportamiento de `alertas`.

const { insertarAlertasBoletin } = require('./insertarAlertasBoletin');
const {
  registrarRawDocuments,
  marcarRawDocumentSaltado,
} = require('../../rawDocuments/rawDocuments.service');

// Bolsa de texto por defecto para el filtro rural (igual que BOJA/BOCYL/BORM).
// join() convierte null/undefined en cadena vacía, así que es seguro aunque el
// scraper no traiga seccion/organismo.
function bolsaPorDefecto(doc) {
  return [
    String(doc.texto || '').slice(0, 3500),
    doc.titulo,
    doc.seccion,
    doc.organismo,
  ].join(' ');
}

async function procesarConFiltroRural(supabase, docs, opciones) {
  const {
    fuente,
    region,
    esRuralRelevante,
    construirBolsa = bolsaPorDefecto,
    contenido,
    motivoFiltro = 'rural_filter_no_match',
  } = opciones;

  const lista = Array.isArray(docs) ? docs : [];

  // 1) Registrar TODO en raw_documents (cada doc recibe raw_document_id).
  const docsConRaw = await registrarRawDocuments(supabase, lista, { fuente, region });

  // 2) Filtro rural como preclasificación: los descartados -> skipped_by_rule.
  let saltadasFiltro = 0;
  const docsInsertables = [];
  for (const doc of docsConRaw) {
    if (!esRuralRelevante(construirBolsa(doc))) {
      saltadasFiltro++;
      await marcarRawDocumentSaltado(supabase, doc.raw_document_id, motivoFiltro);
      continue;
    }
    docsInsertables.push(doc);
  }

  // 3) Insertar el resto; insertarAlertasBoletin enlaza inserted/duplicate/missing_url.
  const { nuevas, duplicadas, errores } = await insertarAlertasBoletin(
    supabase,
    docsInsertables,
    { fuente, region, contenido }
  );

  return {
    totales: lista.length,
    documentos_insertables: lista.length - saltadasFiltro,
    nuevas,
    duplicadas,
    errores,
    saltadasFiltro,
  };
}

module.exports = { procesarConFiltroRural, bolsaPorDefecto };
