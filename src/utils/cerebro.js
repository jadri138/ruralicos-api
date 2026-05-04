const { llamarIA, parsearJSON } = require('./llamarIA');
const {
  parsearVotosDigest,
  parsearVotosNaturalesPorAlertas,
  analizarFeedbackCompleto,
} = require('../brain/feedbackParser');

function confianzaAPeso(confianza) {
  if (confianza === 'alta') return 1.0;
  if (confianza === 'media') return 0.8;
  if (confianza === 'baja') return 0.3;
  const n = Number(confianza);
  if (Number.isFinite(n)) return Math.max(0.3, Math.min(1, n));
  return 0.5;
}

function normalizarInterpretacion(raw = {}) {
  const feedbacks = Array.isArray(raw.feedbacks)
    ? raw.feedbacks
      .map((item) => ({
        item_numero: Number(item.item_numero),
        valor: Number(item.valor),
        confianza: ['alta', 'media', 'baja'].includes(item.confianza) ? item.confianza : 'media',
        razon: String(item.razon || '').slice(0, 500),
      }))
      .filter((item) =>
        Number.isInteger(item.item_numero) &&
        item.item_numero > 0 &&
        [-1, 0, 1].includes(item.valor)
      )
    : [];

  const tiposMemoriaPermitidos = new Set([
    'interes_detectado',
    'desinteres_detectado',
    'dato_explotacion',
    'pregunta_usuario',
    'mensaje_libre',
    'evento_estacional',
    'respuesta_exploracion',
  ]);

  const memoria = Array.isArray(raw.memoria)
    ? raw.memoria
      .map((item) => ({
        tipo: tiposMemoriaPermitidos.has(item.tipo) ? item.tipo : 'mensaje_libre',
        contenido: String(item.contenido || '').trim().slice(0, 1200),
        peso_inicial: confianzaAPeso(item.peso_inicial),
      }))
      .filter((item) => item.contenido.length > 0)
    : [];

  const intencion = ['feedback', 'pregunta', 'queja', 'conversacion', 'otro'].includes(raw.intencion)
    ? raw.intencion
    : 'otro';

  return {
    feedbacks,
    memoria,
    requiere_respuesta: Boolean(raw.requiere_respuesta && raw.respuesta),
    respuesta: String(raw.respuesta || '').trim().slice(0, 800),
    intencion,
    resumen_para_log: String(raw.resumen_para_log || '').trim().slice(0, 500),
  };
}

function formatearAlertas(alertas = []) {
  if (!Array.isArray(alertas) || alertas.length === 0) {
    return 'El usuario no tenia un digest activo.';
  }

  return alertas.map((a, i) => (
    `Item ${i + 1}: "${a.titulo || 'Sin titulo'}"\n` +
    `Sector: ${(a.sectores || []).join(', ') || 'N/A'} | Subsector: ${(a.subsectores || []).join(', ') || 'N/A'}\n` +
    `Tipo: ${(a.tipos_alerta || []).join(', ') || 'N/A'} | Provincia: ${(a.provincias || []).join(', ') || 'nacional'}`
  )).join('\n\n');
}

async function interpretacionFallback({ mensajeUsuario, alertasDelDigest }) {
  const totalItems = Array.isArray(alertasDelDigest) ? alertasDelDigest.length : 0;
  let votos = parsearVotosDigest(mensajeUsuario, totalItems);

  if (votos.length === 0 && totalItems > 0) {
    const natural = parsearVotosNaturalesPorAlertas(mensajeUsuario, alertasDelDigest);
    votos = natural.votos || [];
  }

  const analisis = await analizarFeedbackCompleto(mensajeUsuario);

  return normalizarInterpretacion({
    feedbacks: votos.map((voto) => ({
      item_numero: voto.item,
      valor: voto.valor,
      confianza: 'alta',
      razon: voto.tema ? `Detectado tema ${voto.tema}` : 'Formato local interpretado sin LLM',
    })),
    memoria: [
      ...(analisis.aprende_positivo || []).map((tema) => ({
        tipo: 'interes_detectado',
        contenido: `Le interesa ${tema}`,
        peso_inicial: 0.8,
      })),
      ...(analisis.aprende_negativo || []).map((tema) => ({
        tipo: 'desinteres_detectado',
        contenido: `No le interesa ${tema}`,
        peso_inicial: 0.8,
      })),
    ],
    requiere_respuesta: false,
    respuesta: '',
    intencion: votos.length > 0 ? 'feedback' : 'otro',
    resumen_para_log: votos.length > 0
      ? `Fallback local: ${votos.length} feedback(s)`
      : 'Fallback local sin feedback numerico',
  });
}

async function interpretarMensaje({ mensajeUsuario, usuario, conversacionActiva, alertasDelDigest }) {
  const contextoUsuario = usuario?.contexto_narrativo || usuario?.preferencias_extra || 'Usuario nuevo sin historial.';
  const prompt = `
Eres el cerebro de Ruralicos, una plataforma espanola de alertas agricolas personalizadas.
Interpreta el mensaje del usuario con maxima comprension y sin inventar datos.

PERFIL DEL USUARIO
Nombre: ${usuario?.name || 'Sin nombre'}
Plan: ${usuario?.subscription || 'desconocido'}
Memoria/contexto: ${contextoUsuario}

CONVERSACION ACTIVA
${conversacionActiva ? JSON.stringify(conversacionActiva.contexto_json || {}) : 'No hay conversacion activa.'}

ALERTAS DEL DIGEST
${formatearAlertas(alertasDelDigest)}

MENSAJE DEL USUARIO
"${mensajeUsuario}"

Devuelve exactamente JSON valido:
{
  "feedbacks": [
    {
      "item_numero": 1,
      "valor": 1,
      "confianza": "alta",
      "razon": "dice explicitamente que le interesa"
    }
  ],
  "memoria": [
    {
      "tipo": "interes_detectado",
      "contenido": "Le interesa la gestion del agua",
      "peso_inicial": 0.8
    }
  ],
  "requiere_respuesta": false,
  "respuesta": "",
  "intencion": "feedback",
  "resumen_para_log": "Feedback positivo item 1"
}

Reglas:
- feedbacks solo sobre items del digest.
- valor: 1 interesa, -1 no interesa, 0 neutro.
- confianza: alta, media o baja.
- Entiende "la primera", "la de olivos", "la del porcino", "ambas", "ninguna", "+1", "-2".
- memoria solo si hay informacion util para el futuro.
- Tipos memoria permitidos: interes_detectado, desinteres_detectado, dato_explotacion, pregunta_usuario, mensaje_libre, evento_estacional, respuesta_exploracion.
- Responde por WhatsApp solo si pregunta, se queja, esta confuso o hay una oportunidad natural. Si solo da feedback simple, requiere_respuesta false.
`.trim();

  try {
    const texto = await llamarIA(
      prompt,
      'Devuelve solo JSON valido. Sin markdown, sin explicaciones.',
      'gpt-4o-mini'
    );
    return normalizarInterpretacion(parsearJSON(texto));
  } catch (err) {
    console.warn('[cerebro] Fallback local por error interpretando mensaje:', err.message);
    const fallback = await interpretacionFallback({ mensajeUsuario, alertasDelDigest });
    fallback.resumen_para_log = `${fallback.resumen_para_log}. Error LLM: ${err.message.slice(0, 160)}`;
    return fallback;
  }
}

async function generarPreguntaExploracion(usuario, zonaIncertidumbre) {
  const prompt = `
Eres el asistente de Ruralicos. Necesitas hacer UNA pregunta corta a ${usuario?.name || 'este usuario'}
para entender mejor sus intereses agricolas.

Lo que sabes: ${usuario?.contexto_narrativo || usuario?.preferencias_extra || 'usuario nuevo'}
Incertidumbre: ${zonaIncertidumbre}

Devuelve solo una pregunta natural de WhatsApp, maximo 2 frases.
`.trim();

  return llamarIA(prompt, 'Responde solo con el texto de la pregunta.', 'gpt-4o-mini');
}

async function generarContextoNarrativo(usuario, memorias) {
  const memoriasTexto = (memorias || [])
    .slice(0, 50)
    .map((m) => `- [${m.tipo}] ${m.contenido}`)
    .join('\n');

  const prompt = `
Resume en un parrafo conciso lo que sabemos de este agricultor/ganadero.

Datos registro:
- Nombre: ${usuario?.name || ''}
- Preferencias: ${JSON.stringify(usuario?.preferences || {})}
- Texto libre: ${usuario?.preferencias_extra || 'nada'}

Memoria acumulada:
${memoriasTexto || 'Sin memoria acumulada.'}

Debe ser factual, especifico y util para futuras conversaciones. Devuelve solo el parrafo.
`.trim();

  return llamarIA(prompt, 'Responde solo con el parrafo.', 'gpt-4o-mini');
}

module.exports = {
  interpretarMensaje,
  generarPreguntaExploracion,
  generarContextoNarrativo,
  normalizarInterpretacion,
};
