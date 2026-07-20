const { FUENTES_CONTROLADAS } = require('./officialRuralEvidenceGate');

// Columnas verificadas en public.raw_documents. `subseccion` y
// `tipo_documento` no son columnas: solo se leen, si existen, desde el JSON
// oficial capturado por el scraper.
const RAW_DOCUMENT_OFFICIAL_METADATA_SELECT = [
  'id',
  'inserted_alerta_id',
  'organismo',
  'seccion',
  'boletin',
  'id_oficial',
  'metadata_json',
  'updated_at',
].join(', ');

function primerTexto(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const texto = String(value).trim();
    if (texto) return texto;
  }
  return null;
}

function metadatosOficialesDesdeRawDocument(raw = {}) {
  const metadata = raw.metadata_json && typeof raw.metadata_json === 'object'
    && !Array.isArray(raw.metadata_json)
    ? raw.metadata_json
    : {};

  return {
    organismo: primerTexto(raw.organismo, metadata.organismo),
    seccion: primerTexto(raw.seccion, metadata.seccion, metadata.section),
    subseccion: primerTexto(metadata.subseccion, metadata.subsection),
    tipo_documento: primerTexto(
      metadata.tipo_documento,
      metadata.tipoDocumento,
      metadata.document_type
    ),
    id_oficial: primerTexto(raw.id_oficial, metadata.id_oficial, metadata.idOficial),
    boletin: primerTexto(raw.boletin, metadata.boletin),
  };
}

function combinarMetadatosOficiales(actual = {}, nuevos = {}) {
  const resultado = { ...actual };
  for (const [campo, value] of Object.entries(nuevos)) {
    if (!primerTexto(resultado[campo]) && primerTexto(value)) resultado[campo] = value;
  }
  return resultado;
}

async function adjuntarMetadatosOficialesRaw(supabase, alertas = []) {
  const lista = Array.isArray(alertas) ? alertas : [];
  const idsControlados = lista
    .filter((alerta) => FUENTES_CONTROLADAS.has(String(alerta?.fuente || '').toUpperCase()))
    .map((alerta) => alerta.id)
    .filter((id) => id !== null && id !== undefined);

  if (idsControlados.length === 0) return { alertas: lista, error: null };

  const { data, error } = await supabase
    .from('raw_documents')
    .select(RAW_DOCUMENT_OFFICIAL_METADATA_SELECT)
    .in('inserted_alerta_id', idsControlados)
    .order('updated_at', { ascending: false })
    .order('id', { ascending: false });

  if (error) return { alertas: lista, error };

  const metadataPorAlerta = new Map();
  for (const raw of data || []) {
    if (raw?.inserted_alerta_id === null || raw?.inserted_alerta_id === undefined) continue;
    const key = String(raw.inserted_alerta_id);
    metadataPorAlerta.set(
      key,
      combinarMetadatosOficiales(
        metadataPorAlerta.get(key),
        metadatosOficialesDesdeRawDocument(raw)
      )
    );
  }

  return {
    error: null,
    alertas: lista.map((alerta) => {
      const metadataRaw = metadataPorAlerta.get(String(alerta.id));
      if (!metadataRaw || !Object.values(metadataRaw).some(Boolean)) return alerta;
      return {
        ...alerta,
        metadata_oficial: combinarMetadatosOficiales(
          metadataRaw,
          alerta.metadata_oficial
        ),
      };
    }),
  };
}

module.exports = {
  RAW_DOCUMENT_OFFICIAL_METADATA_SELECT,
  adjuntarMetadatosOficialesRaw,
  combinarMetadatosOficiales,
  metadatosOficialesDesdeRawDocument,
  primerTexto,
};
