/**
 * utils/embeddings.js
 * 
 * GENERADOR DE EMBEDDINGS
 * 
 * Convierte texto en vector de 1536 números que representan el SIGNIFICADO.
 * 
 * USO PRODUCCIÓN: Llamar a OpenAI
 * USO TESTING: Mock local
 */

// OpenAI es OPCIONAL - solo se carga si es realmente necesario
let OpenAI = null;
let openaiClient = null;
let isTestMode = false;

/**
 * Inicializa el cliente de OpenAI
 * En testing, se puede saltar o mockear
 */
function inicializarOpenAI(apiKey = null) {
  // Intentar cargar OpenAI si no está ya cargado
  if (!OpenAI) {
    try {
      OpenAI = require('openai');
    } catch (err) {
      console.warn('[embeddings] OpenAI no instalado. Usando mock para tests.');
      isTestMode = true;
      return;
    }
  }

  if (!apiKey && !process.env.OPENAI_API_KEY) {
    console.warn('[embeddings] ADVERTENCIA: No hay OPENAI_API_KEY. En test mode, usaremos mock.');
    isTestMode = true;
    return;
  }
  
  try {
    openaiClient = new OpenAI({ 
      apiKey: apiKey || process.env.OPENAI_API_KEY 
    });
  } catch (err) {
    console.warn('[embeddings] Error inicializando OpenAI:', err.message);
    isTestMode = true;
  }
}

/**
 * FUNCIÓN 1: Generar embedding de un texto
 * 
 * En PRODUCCIÓN: Llama a OpenAI
 * En TESTING: Devuelve mock determinista (para reproducibilidad)
 * 
 * @param {string} texto - El contenido a convertir
 * @param {boolean} forzarMock - Si true, ignora OpenAI y usa mock
 * @returns {Promise<number[]>} - Array de 1536 números (o menos en mock)
 */
async function generarEmbedding(texto, forzarMock = false) {
  if (!texto || typeof texto !== 'string') {
    throw new Error('generarEmbedding: texto debe ser string no-vacío');
  }

  const textoLimpio = texto.slice(0, 8000).trim();

  // TESTING: Mock determinista
  if (isTestMode || forzarMock) {
    return generarEmbeddingMock(textoLimpio);
  }

  if (!openaiClient) {
    throw new Error('OpenAI no inicializado. Usa inicializarOpenAI(apiKey)');
  }

  try {
    const response = await openaiClient.embeddings.create({
      model: 'text-embedding-3-small',
      input: textoLimpio,
    });

    if (!response.data || !response.data[0] || !response.data[0].embedding) {
      throw new Error('Respuesta inválida de OpenAI');
    }

    return response.data[0].embedding;
  } catch (err) {
    console.error('[embeddings] Error generando embedding:', err.message);
    throw err;
  }
}

/**
 * FUNCIÓN 2: Generar embeddings en LOTE (más eficiente)
 * 
 * Procesa múltiples textos en una sola llamada a OpenAI.
 * Más rápido y más barato que llamar uno por uno.
 * 
 * @param {string[]} textos - Array de textos
 * @param {boolean} forzarMock
 * @returns {Promise<number[][]>} - Array de arrays de números
 */
const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generarEmbeddingsBatch(textos, forzarMock = false, onProgress = null) {
  if (!Array.isArray(textos) || textos.length === 0) {
    throw new Error('generarEmbeddingsBatch: textos debe ser array no-vacío');
  }

  if (isTestMode || forzarMock) {
    const embeddingsMock = textos.map(t => generarEmbeddingMock(t));
    if (typeof onProgress === 'function') onProgress(embeddingsMock.length, textos.length);
    return embeddingsMock;
  }

  if (!openaiClient) {
    throw new Error('OpenAI no inicializado');
  }

  try {
    const resultados = [];

    for (let i = 0; i < textos.length; i += BATCH_SIZE) {
      const lote = textos.slice(i, i + BATCH_SIZE);
      const response = await openaiClient.embeddings.create({
        model: 'text-embedding-3-small',
        input: lote.map(t => t.slice(0, 8000).trim()),
      });

      if (!response.data) {
        throw new Error('Respuesta inválida de OpenAI');
      }

      const embeddingsLote = new Array(lote.length);
      for (const item of response.data) {
        embeddingsLote[item.index] = item.embedding;
      }

      resultados.push(...embeddingsLote);
      if (typeof onProgress === 'function') onProgress(resultados.length, textos.length);

      if (i + BATCH_SIZE < textos.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    return resultados;
  } catch (err) {
    console.error('[embeddings] Error en batch:', err.message);
    throw err;
  }
}

/**
 * FUNCIÓN 3: Mock inteligente para testing
 * 
 * Genera un embedding "falso" pero DETERMINISTA basado en el texto.
 * MEJORADO: Textos similares producen embeddings similares.
 * 
 * @param {string} texto
 * @returns {number[]} - Array de 1536 números (seed-based)
 */
function generarEmbeddingMock(texto) {
  // Crear seed a partir del texto (para reproducibilidad)
  let seed = 0;
  for (let i = 0; i < texto.length; i++) {
    seed = ((seed << 5) - seed) + texto.charCodeAt(i);
    seed = seed & seed; // Convert to 32bit integer
  }

  // Extraer palabras para similitud semántica básica
  const palabras = texto.toLowerCase().split(/\s+/);
  const palabrasHash = Object.fromEntries(
    palabras.map(p => [p, hashPalabra(p)])
  );
  const indicesPorPalabra = palabras.map((palabra) => new Set(obtenerIndicesAfectados(palabrasHash[palabra], 1536)));

  // Generar 1536 números usando la seed + palabras
  const embedding = [];
  for (let i = 0; i < 1536; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    
    // Para cada palabra, contribuir a algunos índices del embedding
    // Esto hace que textos con palabras comunes sean más similares
    let contribucion = (seed / 233280) - 0.5;
    
    for (const indicesAfectados of indicesPorPalabra) {
      if (indicesAfectados.has(i)) {
        // Esta palabra contribuye a este índice del embedding
        contribucion += 0.3; // Peso positivo
      }
    }

    embedding.push(Math.tanh(contribucion)); // Normalizar entre -1 y 1
  }

  return embedding;
}

/**
 * Helper: Hash simple de una palabra
 */
function hashPalabra(palabra) {
  let hash = 0;
  for (let i = 0; i < palabra.length; i++) {
    hash = ((hash << 5) - hash) + palabra.charCodeAt(i);
    hash = hash & hash; // 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Helper: Obtener índices del embedding que una palabra afecta
 */
function obtenerIndicesAfectados(hash, dimension) {
  const indices = new Set();
  let h = hash;
  
  for (let j = 0; j < 5; j++) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    indices.add(h % dimension);
  }
  
  return Array.from(indices);
}

/**
 * FUNCIÓN 4: Calcular similitud entre dos embeddings
 * 
 * "Similitud coseno" → número entre -1 y 1
 * 1 = idénticos, 0 = perpendiculares, -1 = opuestos
 * 
 * Esto es RÁPIDO y no depende de OpenAI.
 * 
 * @param {number[]} vector1 - Array de números
 * @param {number[]} vector2 - Array de números
 * @returns {number} - Similitud entre -1 y 1
 */
function similitudCoseno(vector1, vector2) {
  if (!Array.isArray(vector1) || !Array.isArray(vector2)) {
    throw new Error('similitudCoseno: ambos deben ser arrays');
  }

  if (vector1.length !== vector2.length) {
    throw new Error(`similitudCoseno: vectores de distinto tamaño (${vector1.length} vs ${vector2.length})`);
  }

  if (vector1.length === 0) {
    throw new Error('similitudCoseno: vectores vacíos');
  }

  let productoPunto = 0;
  let norma1 = 0;
  let norma2 = 0;

  for (let i = 0; i < vector1.length; i++) {
    productoPunto += vector1[i] * vector2[i];
    norma1 += vector1[i] * vector1[i];
    norma2 += vector2[i] * vector2[i];
  }

  norma1 = Math.sqrt(norma1);
  norma2 = Math.sqrt(norma2);

  if (norma1 === 0 || norma2 === 0) {
    return 0; // Vector nulo
  }

  return productoPunto / (norma1 * norma2);
}

/**
 * FUNCIÓN 5: Calcular centroide de múltiples embeddings
 * 
 * "Centroide" = promedio de varios vectores
 * Útil para: "¿Cuál es el embedding típico que le interesa a este usuario?"
 * 
 * @param {number[][]} embeddings - Array de arrays de números
 * @returns {number[]} - Promedio (centroide)
 */
function calcularCentroide(embeddings) {
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    throw new Error('calcularCentroide: necesita array no-vacío');
  }

  const dimension = embeddings[0].length;
  const centroide = new Array(dimension).fill(0);

  for (const embedding of embeddings) {
    if (embedding.length !== dimension) {
      throw new Error(`calcularCentroide: inconsistencia de dimensiones`);
    }

    for (let i = 0; i < dimension; i++) {
      centroide[i] += embedding[i];
    }
  }

  // Dividir por cantidad (para obtener promedio)
  for (let i = 0; i < dimension; i++) {
    centroide[i] /= embeddings.length;
  }

  return centroide;
}

/**
 * FUNCIÓN 6: Calcular centroide CON PESO (important para decay temporal)
 * 
 * Igual que calcularCentroide, pero cada embedding tiene un peso.
 * Ejemplos de uso:
 * - Feedback antiguo pesa 0.5
 * - Feedback reciente pesa 1.0
 * 
 * @param {number[][]} embeddings - Array de arrays
 * @param {number[]} pesos - Array de números (pesos correspondientes)
 * @returns {number[]} - Centroide ponderado
 */
function calcularCentroidePonderado(embeddings, pesos) {
  if (!Array.isArray(embeddings) || embeddings.length === 0) {
    throw new Error('calcularCentroidePonderado: necesita embeddings no-vacío');
  }

  if (!Array.isArray(pesos) || pesos.length !== embeddings.length) {
    throw new Error('calcularCentroidePonderado: tamaño de pesos debe coincidir');
  }

  const dimension = embeddings[0].length;
  const centroide = new Array(dimension).fill(0);
  let sumaPesos = 0;

  for (let j = 0; j < embeddings.length; j++) {
    const embedding = embeddings[j];
    const peso = pesos[j];

    if (embedding.length !== dimension) {
      throw new Error('calcularCentroidePonderado: inconsistencia de dimensiones');
    }

    sumaPesos += peso;

    for (let i = 0; i < dimension; i++) {
      centroide[i] += embedding[i] * peso;
    }
  }

  if (sumaPesos === 0) {
    throw new Error('calcularCentroidePonderado: suma de pesos es cero');
  }

  // Dividir por suma de pesos
  for (let i = 0; i < dimension; i++) {
    centroide[i] /= sumaPesos;
  }

  return centroide;
}

module.exports = {
  inicializarOpenAI,
  generarEmbedding,
  generarEmbeddingsBatch,
  generarEmbeddingMock,
  similitudCoseno,
  calcularCentroide,
  calcularCentroidePonderado,
  BATCH_SIZE,
  BATCH_DELAY_MS,
};
