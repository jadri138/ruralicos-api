// Helper compartido de captura bruta auditable para scrapers que filtran EN LA
// RUTA (patrón BOJA): registra TODOS los documentos detectados en raw_documents
// ANTES de filtrar, aplica el prefiltro rural como decisión pass/review/discard.
// Solo discard queda `skipped_by_rule`; pass y review se insertan para que los
// resuelva el preclasificador avanzado o la IA.
//
// Esta capa no usa IA y conserva la decisión completa en raw_documents.

const { insertarAlertasBoletin } = require('./insertarAlertasBoletin');
const {
  registrarRawDocuments,
  marcarRawDocumentSaltado,
} = require('../../rawDocuments/rawDocuments.service');
const {
  PREFILTER_ACTION,
  evaluarPrefiltroRural,
} = require('../../scrapers/shared/ruralFilter');

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

  const evaluados = lista.map((doc) => ({
    ...doc,
    _prefiltro_rural: evaluarPrefiltroRural(
      esRuralRelevante,
      construirBolsa(doc)
    ),
  }));

  // 1) Registrar TODO en raw_documents (cada doc recibe raw_document_id).
  const docsConRaw = await registrarRawDocuments(supabase, evaluados, { fuente, region });

  // 2) Solo un descarte explícito bloquea la inserción. Pass y review llegan al
  // preclasificador avanzado y a la IA.
  let saltadasFiltro = 0;
  const docsInsertables = [];
  const prefiltro = { pass: 0, review: 0, discard: 0 };
  for (const doc of docsConRaw) {
    const action = doc._prefiltro_rural.action;
    prefiltro[action] += 1;

    if (action === PREFILTER_ACTION.DISCARD) {
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
    prefiltro,
  };
}

module.exports = { procesarConFiltroRural, bolsaPorDefecto };
