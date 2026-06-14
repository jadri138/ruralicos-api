// Normalización de títulos y similitud Jaccard para deduplicación de alertas.
const STOPWORDS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'una', 'un', 'en', 'con',
  'por', 'para', 'que', 'se', 'y', 'o', 'a', 'al', 'e', 'u',
  'sobre', 'ante', 'bajo', 'desde', 'entre', 'hasta', 'sin', 'tras',
  'durante', 'mediante', 'segun', 'no', 'ni', 'pero', 'sino', 'aunque',
  'si', 'como', 'lo', 'le', 'les', 'su', 'sus', 'mi', 'mis', 'tu', 'tus',
  'esta', 'este', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas',
  'cual', 'cuales', 'quien', 'quienes', 'mas', 'muy', 'han', 'ha',
  'son', 'ser', 'sido', 'fue', 'dicho',
]);

function normalizar(titulo) {
  return (titulo || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function jaccard(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let interseccion = 0;
  for (const w of setA) { if (setB.has(w)) interseccion++; }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : interseccion / union;
}

function similitudTitulos(tituloA, tituloB) {
  const tokensA = normalizar(tituloA);
  const tokensB = normalizar(tituloB);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  return jaccard(tokensA, tokensB);
}

module.exports = { similitudTitulos, normalizar };
