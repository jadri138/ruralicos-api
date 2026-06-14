const path = require('path');
const crypto = require('crypto');
const { extraerTextoPdf } = require('../shared/pdfExtractor');
const {
  inicializarOpenAI,
  generarEmbeddingsBatch,
} = require('../platform/ia/embeddings');

const DEFAULT_CHUNK_WORDS = 500;
const DEFAULT_OVERLAP_WORDS = 80;
const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.txt', '.md', '.markdown']);

function cleanText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function vectorToSql(vector) {
  if (!Array.isArray(vector)) throw new Error('Vector invalido');
  return `[${vector.map((n) => Number(n)).join(',')}]`;
}

function normalizeExtension(fileName) {
  return path.extname(String(fileName || '')).toLowerCase();
}

function validateSupportedFile(fileName) {
  const ext = normalizeExtension(fileName);
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`Formato no soportado: ${ext || 'sin extension'}. Usa PDF, TXT o MD.`);
  }
  return ext;
}

function chunkText(text, { chunkWords = DEFAULT_CHUNK_WORDS, overlapWords = DEFAULT_OVERLAP_WORDS } = {}) {
  const words = cleanText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const safeChunkWords = Math.max(150, Math.min(1200, Number(chunkWords) || DEFAULT_CHUNK_WORDS));
  const safeOverlap = Math.max(0, Math.min(Math.floor(safeChunkWords / 2), Number(overlapWords) || DEFAULT_OVERLAP_WORDS));
  const step = Math.max(1, safeChunkWords - safeOverlap);
  const chunks = [];

  for (let start = 0; start < words.length; start += step) {
    const part = words.slice(start, start + safeChunkWords).join(' ').trim();
    if (part.length >= 80) chunks.push(part);
    if (start + safeChunkWords >= words.length) break;
  }

  return chunks;
}

async function extractTextFromBuffer(buffer, fileName) {
  const ext = validateSupportedFile(fileName);
  const data = Buffer.from(buffer || '');

  if (ext === '.pdf') return cleanText(await extraerTextoPdf(data));
  return cleanText(data.toString('utf8'));
}

async function findExistingDocument(supabase, { title, category, url, version, organizationId }) {
  let query = supabase
    .from('mia_knowledge_documents')
    .select('id')
    .eq('titulo', title)
    .eq('categoria', category)
    .limit(1);

  if (url) query = query.eq('url', url);
  if (version) query = query.eq('version', version);
  if (organizationId) query = query.eq('organization_id', organizationId);
  else query = query.is('organization_id', null);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data?.id || null;
}

async function upsertDocument(supabase, options) {
  const {
    title,
    category,
    source,
    sourceType,
    url,
    date,
    version,
    organizationId,
    fileName,
    textHash,
  } = options;

  const existingId = await findExistingDocument(supabase, { title, category, url, version, organizationId });
  const row = {
    titulo: title,
    categoria: category,
    fuente: source || null,
    fuente_tipo: sourceType || 'manual',
    url: url || null,
    fecha_documento: date || null,
    version: version || null,
    status: 'active',
    organization_id: organizationId || null,
    metadata_json: {
      file_name: path.basename(fileName || ''),
      text_hash: textHash,
      ingested_at: new Date().toISOString(),
    },
  };

  if (existingId) {
    const { data, error } = await supabase
      .from('mia_knowledge_documents')
      .update(row)
      .eq('id', existingId)
      .select('id')
      .single();
    if (error) throw error;
    return data.id;
  }

  const { data, error } = await supabase
    .from('mia_knowledge_documents')
    .insert(row)
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function replaceChunks(supabase, { documentId, organizationId, title, chunks, embeddings }) {
  const { error: deleteError } = await supabase
    .from('mia_knowledge_chunks')
    .delete()
    .eq('document_id', documentId);
  if (deleteError) throw deleteError;

  const rows = chunks.map((contenido, index) => ({
    document_id: documentId,
    organization_id: organizationId || null,
    chunk_index: index,
    titulo: `${title} (${index + 1})`,
    contenido,
    embedding: vectorToSql(embeddings[index]),
    content_hash: sha256(contenido),
    metadata_json: {
      words: contenido.split(/\s+/).filter(Boolean).length,
    },
  }));

  const { error } = await supabase
    .from('mia_knowledge_chunks')
    .insert(rows);
  if (error) throw error;
}

function normalizeBase64(value) {
  return String(value || '').replace(/^data:[^;]+;base64,/, '').trim();
}

async function ingestKnowledgeDocument(supabase, {
  buffer,
  fileName,
  title,
  category,
  source = null,
  sourceType = 'manual',
  url = null,
  date = null,
  version = null,
  organizationId = null,
  chunkWords = DEFAULT_CHUNK_WORDS,
  overlapWords = DEFAULT_OVERLAP_WORDS,
  useMockEmbeddings = false,
  dryRun = false,
} = {}) {
  const cleanTitle = String(title || '').trim();
  const cleanCategory = String(category || '').trim();
  if (!cleanTitle) throw new Error('title requerido');
  if (!cleanCategory) throw new Error('category requerida');
  if (!buffer) throw new Error('buffer requerido');

  validateSupportedFile(fileName);
  const text = await extractTextFromBuffer(buffer, fileName);
  if (!text) throw new Error('No se pudo extraer texto del documento.');

  const chunks = chunkText(text, { chunkWords, overlapWords });
  if (chunks.length === 0) throw new Error('El documento no genero chunks utiles.');

  const result = {
    ok: true,
    title: cleanTitle,
    category: cleanCategory,
    file_name: path.basename(fileName || ''),
    text_chars: text.length,
    chunks: chunks.length,
    first_chunk_preview: chunks[0].slice(0, 1200),
    dry_run: Boolean(dryRun),
  };

  if (dryRun) return result;

  inicializarOpenAI();
  const embeddings = await generarEmbeddingsBatch(chunks, useMockEmbeddings);
  const orgId = Number.isFinite(Number(organizationId)) && Number(organizationId) > 0
    ? Number(organizationId)
    : null;
  const documentId = await upsertDocument(supabase, {
    title: cleanTitle,
    category: cleanCategory,
    source: source ? String(source).trim() : null,
    sourceType: sourceType ? String(sourceType).trim() : 'manual',
    url: url ? String(url).trim() : null,
    date: date || null,
    version: version ? String(version).trim() : null,
    organizationId: orgId,
    fileName,
    textHash: sha256(text),
  });

  await replaceChunks(supabase, {
    documentId,
    organizationId: orgId,
    title: cleanTitle,
    chunks,
    embeddings,
  });

  return {
    ...result,
    document_id: documentId,
  };
}

module.exports = {
  DEFAULT_CHUNK_WORDS,
  DEFAULT_OVERLAP_WORDS,
  SUPPORTED_EXTENSIONS,
  cleanText,
  chunkText,
  extractTextFromBuffer,
  ingestKnowledgeDocument,
  normalizeBase64,
};
