const { llamarIA, parsearJSON } = require('../utils/llamarIA');

const TEMAS_AGRARIOS = [
  { canonico: 'pac', aliases: ['pac', 'politica agraria comun'] },
  { canonico: 'olivar', aliases: ['olivar', 'olivo', 'olivos', 'aceituna', 'aceitunas'] },
  { canonico: 'porcino', aliases: ['porcino', 'cerdo', 'cerdos', 'cochino', 'cochinos'] },
  { canonico: 'vacuno', aliases: ['vacuno', 'vaca', 'vacas', 'bovino', 'bovinos'] },
  { canonico: 'ovino', aliases: ['ovino', 'oveja', 'ovejas'] },
  { canonico: 'caprino', aliases: ['caprino', 'cabra', 'cabras'] },
  { canonico: 'avicultura', aliases: ['avicultura', 'avicola', 'pollo', 'pollos', 'gallina', 'gallinas'] },
  { canonico: 'almendro', aliases: ['almendro', 'almendros', 'almendra', 'almendras'] },
  { canonico: 'citricos', aliases: ['citricos', 'citrico', 'naranja', 'naranjas', 'limon', 'limones'] },
  { canonico: 'vinedo', aliases: ['vinedo', 'vinedos', 'vino', 'uva', 'uvas', 'vid'] },
  { canonico: 'trigo', aliases: ['trigo'] },
  { canonico: 'cebada', aliases: ['cebada'] },
  { canonico: 'maiz', aliases: ['maiz'] },
  { canonico: 'arroz', aliases: ['arroz'] },
  { canonico: 'agua', aliases: ['agua', 'riego', 'regadio', 'regadios', 'pozo', 'pozos'] },
  { canonico: 'ayuda', aliases: ['ayuda', 'ayudas', 'subvencion', 'subvenciones', 'subsidio', 'subsidios'] },
  { canonico: 'maquinaria agricola', aliases: ['maquinaria agricola', 'maquinaria', 'maquina', 'maquinas', 'tractor', 'tractores', 'apero', 'aperos'] },
  { canonico: 'normativa', aliases: ['normativa', 'norma', 'normas', 'ley', 'leyes'] },
  { canonico: 'medio ambiente', aliases: ['medio ambiente', 'medioambiental', 'ambiental'] },
  { canonico: 'apicultura', aliases: ['apicultura', 'abeja', 'abejas', 'miel'] },
  { canonico: 'forestal', aliases: ['forestal', 'monte', 'montes', 'bosque', 'bosques'] },
  { canonico: 'patata', aliases: ['patata', 'patatas'] },
  { canonico: 'hortalizas', aliases: ['hortaliza', 'hortalizas', 'huerta'] },
  { canonico: 'frutal', aliases: ['frutal', 'frutales', 'fruta'] },
  { canonico: 'trufa', aliases: ['trufa', 'trufas'] },
  { canonico: 'leguminosa', aliases: ['leguminosa', 'leguminosas'] },
  { canonico: 'infraestructura', aliases: ['infraestructura', 'infraestructuras', 'obra', 'obras'] },
  { canonico: 'fiscal', aliases: ['fiscal', 'fiscalidad', 'impuesto', 'impuestos'] },
];

const PROVINCIAS = [
  'castellon', 'zaragoza', 'huesca', 'teruel', 'palencia', 'valladolid', 'cuenca',
  'albacete', 'murcia', 'almeria', 'jaen', 'cordoba', 'sevilla', 'toledo',
  'badajoz', 'caceres', 'guadalajara', 'soria', 'segovia', 'avila', 'salamanca',
];

function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function temaCanonico(tema) {
  const normalizado = normalizarTexto(tema).trim();
  const found = TEMAS_AGRARIOS.find((item) => item.aliases.includes(normalizado));
  return found ? found.canonico : normalizado;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contieneAliasTema(textoNormalizado, tema) {
  const canonico = temaCanonico(tema);
  const item = TEMAS_AGRARIOS.find((t) => t.canonico === canonico);
  const aliases = item ? item.aliases : [canonico];

  return aliases.some((alias) => {
    const escaped = escapeRegex(normalizarTexto(alias));
    const pattern = alias.includes(' ')
      ? new RegExp(`(^|\\W)${escaped}(\\W|$)`, 'i')
      : new RegExp(`\\b${escaped}\\b`, 'i');
    return pattern.test(textoNormalizado);
  });
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

function parsearVotosDigest(texto, totalItems = null) {
  const normalizado = normalizarTexto(texto)
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

  function aplicarRestoNegativoSiProcede() {
    if (!tieneTotal) return;
    const positivos = votos
      .filter((voto) => voto.valor === 1)
      .map((voto) => voto.item);
    if (positivos.length === 0) return;

    const hablaDelResto = /\b(el\s+)?resto\b/.test(normalizado);
    const restoNegativo =
      hablaDelResto &&
      /\b(no me interesa(?:n)? tanto|no me interesa(?:n)?|no tanto|menos|poco util|irrelevante|fuera|quitar|quita|no lo quiero|no los quiero|no me va)\b/.test(normalizado);

    if (!restoNegativo) return;

    for (let item = 1; item <= total; item++) {
      if (!positivos.includes(item)) add(item, -1);
    }
  }

  if (tieneTotal && /\b(ambas|todos|todas|los dos|las dos)\b/.test(normalizado)) {
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

  for (const match of normalizado.matchAll(/\b(?:me interesa(?:n)?|interesa(?:n)?|me gusta(?:n)?)\b(?:\s+(?:el|la|los|las|item|items|numero|numeros))?\s+((?:\d{1,2}|el|la|los|las|y|,|;|\s)+)/g)) {
    for (const n of match[1].match(/\d{1,2}/g) || []) add(n, 1);
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

  aplicarRestoNegativoSiProcede();

  return votos;
}

function extraerMencionesPosNeg(textoUsuario) {
  const texto = normalizarTexto(textoUsuario);
  const temas = [...TEMAS_AGRARIOS.map((item) => item.canonico), ...PROVINCIAS];
  const positivas = [];
  const negativas = [];

  const bloqueNegativoRegex = /\b(?:pero no|no|sin|ni|evitar|quita|quitar|fuera|menos)\b[^.!?,;]*/gi;
  const bloquesNegativos = texto.match(bloqueNegativoRegex) || [];
  const textoPositivo = bloquesNegativos.length > 0
    ? texto.replace(new RegExp(bloquesNegativos.map(escapeRegex).join('|'), 'gi'), ' ')
    : texto;

  for (const tema of temas) {
    if (contieneAliasTema(textoPositivo, tema)) {
      const canonico = temaCanonico(tema);
      if (!positivas.includes(canonico)) positivas.push(canonico);
    }
  }

  for (const bloque of bloquesNegativos) {
    for (const tema of temas) {
      if (contieneAliasTema(bloque, tema)) {
        const canonico = temaCanonico(tema);
        if (!negativas.includes(canonico)) negativas.push(canonico);
      }
    }
  }

  for (const tema of temas) {
    const canonico = temaCanonico(tema);
    const item = TEMAS_AGRARIOS.find((t) => t.canonico === canonico);
    const aliases = item ? item.aliases : [canonico];
    const apareceCercaDeNegacion = aliases.some((alias) => {
      const escaped = escapeRegex(normalizarTexto(alias));
      const temaAntesDeNegacion = new RegExp(`\\b${escaped}\\b[^.,;!?]{0,60}\\b(no me interesa(?:n)? tanto|no me interesa(?:n)?|no tanto|me interesa(?:n)? menos|no me va|no quiero|evitar|quita|quitar|fuera)\\b`, 'i');
      const negacionAntesDeTema = new RegExp(`\\b(no me interesa(?:n)? tanto|no me interesa(?:n)?|no tanto|me interesa(?:n)? menos|no me va|no quiero|evitar|quita|quitar|fuera)\\b[^.,;!?]{0,60}\\b${escaped}\\b`, 'i');
      return temaAntesDeNegacion.test(texto) || negacionAntesDeTema.test(texto);
    });

    if (apareceCercaDeNegacion && !negativas.includes(canonico)) {
      negativas.push(canonico);
    }
  }

  for (const negativa of negativas) {
    const index = positivas.indexOf(negativa);
    if (index !== -1) positivas.splice(index, 1);
  }

  return { positivas, negativas };
}

function textoBusquedaAlerta(alerta = {}) {
  return normalizarTexto([
    alerta.titulo,
    alerta.resumen,
    alerta.resumen_final,
    alerta.fuente,
    ...(Array.isArray(alerta.provincias) ? alerta.provincias : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta : []),
  ].filter(Boolean).join(' '));
}

function parsearVotosNaturalesPorAlertas(textoUsuario, alertasOrdenadas = []) {
  const menciones = extraerMencionesPosNeg(textoUsuario);
  const votos = [];
  const vistos = new Set();

  function add(item, valor, tema) {
    const key = `${item}:${valor}`;
    if (vistos.has(key)) return;
    vistos.add(key);
    votos.push({ item, valor, tema });
  }

  (alertasOrdenadas || []).forEach((alerta, index) => {
    const textoAlerta = textoBusquedaAlerta(alerta);
    for (const tema of menciones.positivas) {
      if (contieneAliasTema(textoAlerta, tema)) add(index + 1, 1, tema);
    }
    for (const tema of menciones.negativas) {
      if (contieneAliasTema(textoAlerta, tema)) add(index + 1, -1, tema);
    }
  });

  return {
    votos,
    menciones,
    matched: votos.length > 0,
  };
}

async function entenderIntencionUsuario(textoUsuario, alertaContexto = null) {
  if (!textoUsuario || typeof textoUsuario !== 'string' || textoUsuario.trim().length < 3) {
    return { sentimiento: 'neutral', temas: [], confianza: 0 };
  }

  const texto = textoUsuario.trim();
  const menciones = extraerMencionesPosNeg(texto);

  if (menciones.positivas.length > 0 || menciones.negativas.length > 0) {
    return {
      sentimiento: menciones.positivas.length > 0 ? 'positivo' : 'negativo',
      temas: [...new Set([...menciones.positivas, ...menciones.negativas])],
      confianza: 0.9,
      rapido: true,
    };
  }

  if (/^(\+1|me gusta|excelente|perfecto|si|sí|1|yes|interesa)$/i.test(texto)) {
    return { sentimiento: 'positivo', temas: [], confianza: 1.0, rapido: true };
  }
  if (/^(-1|no me gusta|mal|no|0|nope|no interesa)$/i.test(texto)) {
    return { sentimiento: 'negativo', temas: [], confianza: 1.0, rapido: true };
  }

  try {
    const prompt = `
TAREA: Analiza este mensaje de un usuario agricola sobre una alerta/boletin.

MENSAJE: "${texto}"

${alertaContexto ? `
CONTEXTO:
- ${alertaContexto.titulo || 'alerta'}
- Sectores: ${alertaContexto.sectores?.join(', ') || 'N/A'}
- Subsectores: ${alertaContexto.subsectores?.join(', ') || 'N/A'}
- Provincias: ${alertaContexto.provincias?.join(', ') || 'Nacional'}
` : ''}

Devuelve solo JSON:
{
  "sentimiento": "positivo|negativo|neutral",
  "temas": ["olivar", "castellon"],
  "confianza": 0.85
}
    `.trim();

    const respuestaTexto = await llamarIA(
      prompt,
      'Devuelve solo JSON valido. Sin markdown, sin explicaciones.',
      'gpt-4o-mini'
    );
    const respuesta = parsearJSON(respuestaTexto);
    if (respuesta?.sentimiento && Array.isArray(respuesta.temas)) {
      return {
        sentimiento: respuesta.sentimiento || 'neutral',
        temas: respuesta.temas.map(temaCanonico),
        confianza: Math.max(0, Math.min(1, Number(respuesta.confianza) || 0.5)),
      };
    }
  } catch (err) {
    console.warn('[feedbackParser] Error en IA:', err.message);
  }

  return { sentimiento: 'neutral', temas: [], confianza: 0 };
}

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
    const intencion = await entenderIntencionUsuario(textoUsuario, alertaContexto);
    const menciones = extraerMencionesPosNeg(textoUsuario);

    let aprende_positivo = [];
    let aprende_negativo = [];

    if (intencion.sentimiento === 'positivo') {
      aprende_positivo = menciones.positivas;
      aprende_negativo = menciones.negativas;
    } else if (intencion.sentimiento === 'negativo') {
      aprende_negativo = menciones.positivas;
      aprende_positivo = menciones.negativas;
    } else {
      aprende_positivo = menciones.positivas;
      aprende_negativo = menciones.negativas;
    }

    return {
      sentimiento: intencion.sentimiento,
      aprende_positivo: [...new Set(aprende_positivo)],
      aprende_negativo: [...new Set(aprende_negativo)],
      confianza: intencion.confianza,
      es_valido: intencion.confianza > 0.3 || aprende_positivo.length > 0 || aprende_negativo.length > 0,
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
  extraerMencionesPosNeg,
  parsearVotosNaturalesPorAlertas,
  entenderIntencionUsuario,
  analizarFeedbackCompleto,
};
