const crypto = require('crypto');
const { similitudTitulos } = require('../../../shared/similitud');

const DOCUMENT_RELATION = Object.freeze({
  NEW: 'new_document',
  EXACT_DUPLICATE: 'exact_duplicate',
  CROSS_SOURCE_REPUBLICATION: 'cross_source_republication',
  LEGAL_CORRECTION: 'legal_correction',
  LEGAL_UPDATE: 'legal_update',
  SAME_SUBJECT_NEW_PROCEDURE: 'same_subject_new_procedure',
});

function normalizar(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textoDocumento(documento = {}) {
  return [documento.titulo, documento.contenido, documento.resumen_final, documento.resumen]
    .filter(Boolean)
    .join(' ');
}

function hashContenido(documento = {}) {
  const supplied = documento.contenido_hash || documento.content_hash || documento.hash;
  if (supplied) return String(supplied);
  const content = normalizar(documento.contenido || documento.texto_raw || '');
  return content ? crypto.createHash('sha256').update(content).digest('hex') : null;
}

function extraerReferenciaLegal(documento = {}) {
  const text = normalizar(textoDocumento(documento));
  const match = text.match(/\b(ley|real decreto(?:-ley)?|decreto(?:-ley)?|orden|resolucion)\s+([a-z0-9-]+\/20\d{2})\b/i);
  return match ? `${match[1].replace(/\s+/g, '_')}:${match[2]}` : null;
}

function esCorreccion(documento = {}) {
  return /\b(correccion de errores|correccion de erratas|fe de erratas)\b/.test(normalizar(textoDocumento(documento)));
}

function esActualizacion(documento = {}) {
  return /\b(modifica|modificacion|actualiza|actualizacion|deroga parcialmente|se da nueva redaccion)\b/.test(normalizar(textoDocumento(documento)));
}

function clasificarRelacionDocumental(canonico = {}, candidato = {}, options = {}) {
  const canonicalHash = hashContenido(canonico);
  const candidateHash = hashContenido(candidato);
  const canonicalReference = extraerReferenciaLegal(canonico);
  const candidateReference = extraerReferenciaLegal(candidato);
  const titleSimilarity = similitudTitulos(canonico.titulo || '', candidato.titulo || '');
  const sameSource = normalizar(canonico.fuente) === normalizar(candidato.fuente);
  const sameReference = Boolean(canonicalReference && canonicalReference === candidateReference);
  const evidence = {
    canonical_reference: canonicalReference,
    candidate_reference: candidateReference,
    canonical_content_hash: canonicalHash,
    candidate_content_hash: candidateHash,
    title_similarity: Number(titleSimilarity.toFixed(4)),
    same_source: sameSource,
  };

  if (canonicalHash && candidateHash && canonicalHash === candidateHash) {
    return { relation: DOCUMENT_RELATION.EXACT_DUPLICATE, evidence };
  }
  if (esCorreccion(candidato) && (sameReference || titleSimilarity >= 0.45)) {
    return { relation: DOCUMENT_RELATION.LEGAL_CORRECTION, evidence };
  }
  if (esActualizacion(candidato) && (sameReference || titleSimilarity >= 0.55)) {
    return { relation: DOCUMENT_RELATION.LEGAL_UPDATE, evidence };
  }
  if (sameReference && !sameSource) {
    return { relation: DOCUMENT_RELATION.CROSS_SOURCE_REPUBLICATION, evidence };
  }
  if (sameReference && sameSource && titleSimilarity >= 0.8) {
    return { relation: DOCUMENT_RELATION.EXACT_DUPLICATE, evidence };
  }
  const procedureThreshold = Number(options.sameSubjectThreshold || 0.65);
  if (titleSimilarity >= procedureThreshold) {
    return { relation: DOCUMENT_RELATION.SAME_SUBJECT_NEW_PROCEDURE, evidence };
  }
  return { relation: DOCUMENT_RELATION.NEW, evidence };
}

function esRelacionDuplicada(relation) {
  return [
    DOCUMENT_RELATION.EXACT_DUPLICATE,
    DOCUMENT_RELATION.CROSS_SOURCE_REPUBLICATION,
  ].includes(relation);
}

module.exports = {
  DOCUMENT_RELATION,
  clasificarRelacionDocumental,
  esActualizacion,
  esCorreccion,
  esRelacionDuplicada,
  extraerReferenciaLegal,
  hashContenido,
};
