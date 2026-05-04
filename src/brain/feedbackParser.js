function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extraerTextoEntrante(body = {}) {
  const data = parseMaybeJson(body.data) || body.data || {};
  const message = parseMaybeJson(body.message) || body.message || {};
  const dataMessage = parseMaybeJson(data.message) || data.message || {};

  return firstString([
    body.body,
    body.Body,
    body.text,
    body.message,
    message.body,
    message.text,
    data.body,
    data.text,
    data.message,
    dataMessage.body,
    dataMessage.text,
  ]);
}

function extraerTelefonoEntrante(body = {}) {
  const data = parseMaybeJson(body.data) || body.data || {};
  const message = parseMaybeJson(body.message) || body.message || {};
  const dataMessage = parseMaybeJson(data.message) || data.message || {};
  const raw =
    body.from ||
    body.From ||
    body.author ||
    body.phone ||
    message.from ||
    message.author ||
    message.phone ||
    data.from ||
    data.author ||
    data.phone ||
    data.sender ||
    dataMessage.from ||
    dataMessage.author ||
    dataMessage.phone ||
    '';

  return String(raw || '').replace(/\D/g, '');
}

function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function firstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function parsearVotosDigest(texto, totalItems = null) {
  const original = String(texto || '').trim();
  const normalizado = normalizarTexto(original)
    .replace(/[\u{1F44D}\u{2705}\u{2B50}\u{1F31F}\u{1F49A}]/gu, '+')
    .replace(/[\u{1F44E}\u{274C}\u{1F6D1}]/gu, '-');

  const votos = [];
  const vistos = new Set();

  function add(numero, valor) {
    const item = Number(numero);
    if (!Number.isInteger(item) || item < 1 || item > 20) return;
    const key = `${item}:${valor}`;
    if (vistos.has(key)) return;
    vistos.add(key);
    votos.push({ item, valor });
  }

  const total = Number(totalItems || 0);
  const tieneTotal = Number.isInteger(total) && total > 0;

  if (tieneTotal && /\b(ambas|todos|todas|los dos|las dos|todo)\b/.test(normalizado)) {
    for (let item = 1; item <= total; item++) add(item, 1);
    return votos;
  }

  if (tieneTotal && /\b(ninguna|ninguno|nada|no)\b/.test(normalizado) && !/\d/.test(normalizado)) {
    for (let item = 1; item <= total; item++) add(item, -1);
    return votos;
  }

  for (const match of normalizado.matchAll(/([+-])\s*(\d{1,2})/g)) {
    add(match[2], match[1] === '+' ? 1 : -1);
  }

  for (const match of normalizado.matchAll(/(\d{1,2})([+-])/g)) {
    add(match[1], match[2] === '+' ? 1 : -1);
  }

  for (const match of normalizado.matchAll(/\b(bien|buena|bueno|util|importante|me interesa|si)\s+((?:\d{1,2}[\s,;y]*)+)/g)) {
    for (const n of match[2].match(/\d{1,2}/g) || []) add(n, 1);
  }

  for (const match of normalizado.matchAll(/\b(mal|mala|malo|no util|no me interesa|irrelevante|no)\s+((?:\d{1,2}[\s,;y]*)+)/g)) {
    for (const n of match[2].match(/\d{1,2}/g) || []) add(n, -1);
  }

  for (const match of normalizado.matchAll(/\b(quitar|quita|borrar|borra|fuera|menos|no mandar|no enviar)\s+((?:\d{1,2}[\s,;y]*)+)/g)) {
    for (const n of match[2].match(/\d{1,2}/g) || []) add(n, -1);
  }

  if (votos.length === 0 && /^\s*\d{1,2}(\s*[,;y]\s*\d{1,2})*\s*$/.test(normalizado)) {
    const compact = normalizado.replace(/\s+/g, '');
    if (tieneTotal && total <= 9 && /^\d{2,9}$/.test(compact) && !/[,;y]/.test(normalizado)) {
      for (const n of compact.split('')) add(n, 1);
    } else {
      for (const n of normalizado.match(/\d{1,2}/g) || []) add(n, 1);
    }
  }

  return votos;
}

/**
 * ═════════════════════════════════════════════════════════════════════
 * NUEVAS FUNCIONES PARA ENTENDER LENGUAJE NATURAL DEL USUARIO
 * ═════════════════════════════════════════════════════════════════════
 * 
 * ESTO ES LO NUEVO: El sistema NO necesita "+1" o "-2".
 * El usuario escribe en español normal: "Me interesa el olivar"
 * Y el sistema ENTIENDE y APRENDE.
 */

const { llamarIA } = require('../utils/llamarIA');

/**
 * FUNCIÓN 1: Convierte texto natural en "sentimiento + categorías"
 * 
 * El usuario dice: "Me interesa mucho el olivar en Castellón"
 * El sistema extrae: { 
 *   sentimiento: 'positivo', 
 *   temas: ['olivar', 'Castellón']
 * }
 */
async function entenderIntencionUsuario(textoUsuario, alertaContexto = null) {
  if (!textoUsuario || typeof textoUsuario !== 'string' || textoUsuario.trim().length < 3) {
    return { sentimiento: 'neutral', temas: [], confianza: 0 };
  }

  const texto = textoUsuario.trim();

  // Atajos rápidos (no llamar a IA para cosas obvias)
  if (/^(\+1|me gusta|excelente|perfecto|si|sí|1|yes|interesa)$/i.test(texto)) {
    return { sentimiento: 'positivo', temas: [], confianza: 1.0, rapido: true };
  }
  if (/^(-1|no me gusta|mal|no|0|nope|no interesa)$/i.test(texto)) {
    return { sentimiento: 'negativo', temas: [], confianza: 1.0, rapido: true };
  }

  try {
    const prompt = `
TAREA: Analiza este mensaje de un usuario agrícola sobre una alerta/boletín.

MENSAJE: "${texto}"

${alertaContexto ? `
CONTEXTO - La alerta trataba sobre:
- ${alertaContexto.titulo || 'alerta'}
- Sectores: ${alertaContexto.sectores?.join(', ') || 'N/A'}
- Subsectores: ${alertaContexto.subsectores?.join(', ') || 'N/A'}
- Provincias: ${alertaContexto.provincias?.join(', ') || 'Nacional'}
` : ''}

PREGUNTAS QUE DEBES RESPONDER:

1. ¿Qué SENTIMIENTO expresó?
   Opciones: "positivo" (le GUSTÓ), "negativo" (NO le gustó), "neutral" (indiferente)

2. ¿Qué TEMAS mencionó? (lista de palabras clave)
   Busca: subsectores (olivar, porcino, trigo...), provincias (Castellón, Zaragoza...)
   Devuelve como lista JSON

3. ¿Qué tan seguro estás? (0-1)
   1.0 = muy claro ("Adoro el olivar")
   0.5 = moderado ("Esto está bien")
   0.2 = muy vago ("Ok")

RESPUESTA (solo JSON, nada más):
{
  "sentimiento": "positivo|negativo|neutral",
  "temas": ["olivar", "castellón"],
  "confianza": 0.85
}
    `.trim();

    const respuesta = await llamarIA(prompt, 'json', 0.2);
    
    if (respuesta?.sentimiento && Array.isArray(respuesta.temas)) {
      return {
        sentimiento: respuesta.sentimiento || 'neutral',
        temas: respuesta.temas || [],
        confianza: Math.max(0, Math.min(1, Number(respuesta.confianza) || 0.5)),
      };
    }
  } catch (err) {
    console.warn('[feedbackParser] Error en IA:', err.message);
  }

  return { sentimiento: 'neutral', temas: [], confianza: 0 };
}

/**
 * FUNCIÓN 2: Extrae MENCIONES (qué cosas nombró el usuario)
 * 
 * Entrada: "Me interesa el olivar de Castellón pero no el porcino"
 * Salida: { positivas: ['olivar', 'castellón'], negativas: ['porcino'] }
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extraerMencionesPosNeg(textoUsuario) {
  const palabrasClave = {
    subsectores: [
      'olivar', 'porcino', 'vacuno', 'ovino', 'caprino', 'avicultura', 'avicola',
      'trigo', 'cebada', 'maiz', 'arroz', 'hortalizas', 'frutal', 'trufa', 'viñedo',
      'almendro', 'citricos', 'leguminosa', 'patata', 'forestal', 'apicultura',
    ],
    tipos_alerta: [
      'ayuda', 'subvencion', 'normativa', 'agua', 'infraestructura', 'fiscal',
      'medioambiental', 'medio ambiente',
    ],
    provincias: [
      'castellón', 'zaragoza', 'huesca', 'teruel', 'palencia', 'valladolid', 'cuenca',
      'albacete', 'murcia', 'almería', 'jaén', 'córdoba', 'sevilla', 'córdoba', 'toledo',
      'badajoz', 'cáceres', 'guadalajara', 'soria', 'segovia', 'avila', 'salamanca',
    ],
  };

  const texto = textoUsuario.toLowerCase();
  const positivas = [];
  const negativas = [];

  // Detectar bloques de frase con negaciones simples
  const bloqueNegativoRegex = /\b(?:no|sin|ni)\b[^.!?,;]*/gi;
  const textoNegativo = texto.match(bloqueNegativoRegex) || [];

  const textoPositivo = textoNegativo.length > 0
    ? texto.replace(new RegExp(textoNegativo.map(escapeRegex).join('|'), 'gi'), ' ') 
    : texto;

  // Extraer menciones positivas
  for (const categoria of Object.keys(palabrasClave)) {
    for (const palabra of palabrasClave[categoria]) {
      if (textoPositivo.includes(palabra) && !positivas.includes(palabra)) {
        positivas.push(palabra);
      }
    }
  }

  // Extraer menciones negativas
  for (const bloqueNegativo of textoNegativo) {
    for (const categoria of Object.keys(palabrasClave)) {
      for (const palabra of palabrasClave[categoria]) {
        if (bloqueNegativo.includes(palabra) && !negativas.includes(palabra)) {
          negativas.push(palabra);
        }
      }
    }
  }

  return { positivas, negativas };
}

/**
 * FUNCIÓN 3: LA FUNCIÓN MAESTRA - Entiende TODO lo que escribe el usuario
 * 
 * ENTRADA:
 *   - Texto del usuario: "Me encanta el olivar en Castellón pero no quiero ver porcino"
 *   - Contexto (opcional): La alerta que vio
 * 
 * SALIDA: Un "resumen" que el sistema puede aprender y guardar
 *   {
 *     sentimiento: 'positivo',
 *     aprende_positivo: ['olivar', 'castellón'],  // Esto LE INTERESA
 *     aprende_negativo: ['porcino'],              // Esto NO le interesa
 *     confianza: 0.92,
 *     es_valido: true
 *   }
 */
async function analizarFeedbackCompleto(textoUsuario, alertaContexto = null) {
  if (!textoUsuario || typeof textoUsuario !== 'string' || textoUsuario.trim().length === 0) {
    return {
      sentimiento: 'neutral',
      aprende_positivo: [],
      aprende_negativo: [],
      confianza: 0,
      es_valido: false,
      razon: 'texto_vacio',
    };
  }

  try {
    // Paso 1: Entender intención general con IA
    const intencion = await entenderIntencionUsuario(textoUsuario, alertaContexto);

    // Paso 2: Extraer menciones positivas y negativas
    const menciones = extraerMencionesPosNeg(textoUsuario);

    // Paso 3: Combinar según el sentimiento
    let aprende_positivo = [];
    let aprende_negativo = [];

    if (intencion.sentimiento === 'positivo') {
      aprende_positivo = menciones.positivas;
      aprende_negativo = menciones.negativas;
    } else if (intencion.sentimiento === 'negativo') {
      aprende_negativo = menciones.positivas;
      aprende_positivo = menciones.negativas;
    } else {
      // Si es neutral, solo registrar lo que dijo claramente
      aprende_positivo = menciones.positivas;
      aprende_negativo = menciones.negativas;
    }

    return {
      sentimiento: intencion.sentimiento,
      aprende_positivo: [...new Set(aprende_positivo)], // Eliminar duplicados
      aprende_negativo: [...new Set(aprende_negativo)],
      confianza: intencion.confianza,
      es_valido: intencion.confianza > 0.3,
      temas_mencionados: [...new Set([...menciones.positivas, ...menciones.negativas])],
    };
  } catch (err) {
    console.error('[feedbackParser] Error en analizarFeedbackCompleto:', err.message);
    return {
      sentimiento: 'neutral',
      aprende_positivo: [],
      aprende_negativo: [],
      confianza: 0,
      es_valido: false,
      razon: 'error_procesamiento',
      error: err.message,
    };
  }
}

module.exports = {
  extraerTextoEntrante,
  extraerTelefonoEntrante,
  parsearVotosDigest,
  // NUEVAS FUNCIONES INTELIGENTES
  entenderIntencionUsuario,
  extraerMencionesPosNeg,
  analizarFeedbackCompleto,
};
