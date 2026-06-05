const { llamarIA, parsearJSON } = require('./llamarIA');
const {
  parsearVotosDigest,
  parsearVotosNaturalesPorAlertas,
  analizarFeedbackCompleto,
  esComentarioTramiteOEspera,
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

function normalizarTextoCerebro(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function esMensajePreferenciaFutura(mensajeUsuario) {
  const texto = normalizarTextoCerebro(mensajeUsuario);
  if (!texto) return false;

  const pideRecibir =
    /\b(me gustaria|quisiera|quiero|me interesaria|podriais|podeis|mandadme|enviadme|avisadme|avisame|avisenme)\b[^.!?]{0,80}\b(recibir|avisos?|avisarais|avisarme|avisarnos|alertas?|notificaciones?|mensajes?|informacion)\b/.test(texto) ||
    /\b(recibir|mandadme|enviadme|avisadme|avisame|avisenme|avisarais|avisarme|avisarnos)\b[^.!?]{0,80}\b(avisos?|alertas?|notificaciones?|informacion)\b/.test(texto);

  return pideRecibir && /\b(sobre|de|del|para)\b/.test(texto);
}

function tieneReferenciaDirectaADigest(mensajeUsuario) {
  const texto = normalizarTextoCerebro(mensajeUsuario);
  if (!texto) return false;

  return (
    /[+-]\s*\d{1,2}\b/.test(texto) ||
    /\b\d{1,2}\s*[+-]\b/.test(texto) ||
    /\b(item|items|numero|numeros|primera|segunda|tercera|cuarta|quinta|sexta|septima|esta|esa|la de|lo de|ambas|todas|todos|ninguna|ninguno|resto)\b/.test(texto)
  );
}

function reforzarInterpretacionConReglasLocales(interpretacion, mensajeUsuario, alertasDelDigest = []) {
  const totalItems = Array.isArray(alertasDelDigest) ? alertasDelDigest.length : 0;
  if (totalItems <= 0) return interpretacion;

  if (esComentarioTramiteOEspera(mensajeUsuario)) {
    const texto = normalizarTextoCerebro(mensajeUsuario);
    const parecePregunta = /\?|¿|\b(cuando|sabes|puedes|podrias|podriais|me puedes|me podeis|que hago|donde|como|plazo|resolver)\b/.test(texto);
    return normalizarInterpretacion({
      ...interpretacion,
      feedbacks: [],
      memoria: parecePregunta
        ? [{ tipo: 'pregunta_usuario', contenido: String(mensajeUsuario || '').trim().slice(0, 500), peso_inicial: 0.6 }]
        : [],
      requiere_respuesta: false,
      respuesta: '',
      intencion: parecePregunta ? 'pregunta' : 'otro',
      resumen_para_log: `${interpretacion.resumen_para_log || ''} Comentario de tramite/espera: no se vota el digest.`.trim(),
    });
  }

  const feedbacks = [...(interpretacion.feedbacks || [])];
  const memoria = [...(interpretacion.memoria || [])];
  const itemsYaInterpretados = new Set(feedbacks.map((item) => item.item_numero));

  const votosNumericos = parsearVotosDigest(mensajeUsuario, totalItems);
  const votosNaturales = parsearVotosNaturalesPorAlertas(mensajeUsuario, alertasDelDigest).votos || [];
  const votosLocales = [...votosNumericos, ...votosNaturales];

  for (const voto of votosLocales) {
    if (itemsYaInterpretados.has(voto.item)) continue;
    feedbacks.push({
      item_numero: voto.item,
      valor: voto.valor,
      confianza: voto.valor === -1 ? 'media' : 'alta',
      razon: voto.tema
        ? `Regla local: detectado tema ${voto.tema}`
        : 'Regla local: matiz numerico o "el resto" detectado',
    });
    itemsYaInterpretados.add(voto.item);
  }

  const natural = parsearVotosNaturalesPorAlertas(mensajeUsuario, alertasDelDigest);
  const contenidosMemoria = new Set(memoria.map((item) => `${item.tipo}:${item.contenido.toLowerCase()}`));

  for (const tema of natural.menciones?.positivas || []) {
    const contenido = `Le interesa ${tema}`;
    const key = `interes_detectado:${contenido.toLowerCase()}`;
    if (!contenidosMemoria.has(key)) {
      memoria.push({ tipo: 'interes_detectado', contenido, peso_inicial: 0.8 });
      contenidosMemoria.add(key);
    }
  }

  for (const tema of natural.menciones?.negativas || []) {
    const contenido = `No le interesa tanto ${tema}`;
    const key = `desinteres_detectado:${contenido.toLowerCase()}`;
    if (!contenidosMemoria.has(key)) {
      memoria.push({ tipo: 'desinteres_detectado', contenido, peso_inicial: 0.8 });
      contenidosMemoria.add(key);
    }
  }

  const resumenExtra = votosLocales.some((voto) => voto.valor === -1)
    ? ' Reglas locales reforzaron desintereses suaves.'
    : '';

  if (esMensajePreferenciaFutura(mensajeUsuario) && !tieneReferenciaDirectaADigest(mensajeUsuario)) {
    return normalizarInterpretacion({
      ...interpretacion,
      feedbacks: [],
      memoria,
      intencion: memoria.length > 0 ? 'conversacion' : 'otro',
      resumen_para_log: `${interpretacion.resumen_para_log || ''} Preferencia futura guardada sin votar el digest.`.trim(),
    });
  }

  return normalizarInterpretacion({
    ...interpretacion,
    feedbacks,
    memoria,
    intencion: feedbacks.length > 0 ? 'feedback' : interpretacion.intencion,
    resumen_para_log: `${interpretacion.resumen_para_log || ''}${resumenExtra}`.trim(),
  });
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
- Si el usuario dice "me interesa 2 y 3, el resto no/no tanto/no me interesa tanto", marca 2 y 3 como positivos y los demas items del digest como negativos con confianza media.
- Si dice que un tema no le interesa tanto, por ejemplo "lo del agua no me interesa tanto", marca negativos los items del digest relacionados con ese tema aunque no cite su numero.
- "No me interesa tanto" es una senal negativa suave: guardala como feedback negativo de confianza media y como desinteres_detectado, no la ignores.
- Si el usuario pide recibir avisos, alertas o informacion sobre temas futuros ("quiero recibir avisos sobre PAC", "me gustaria que me avisarais de tractores"), NO lo conviertas en feedback del digest salvo que mencione claramente un item o una alerta del digest. Guardalo solo como memoria/interes_detectado.
- memoria solo si hay informacion util para el futuro.
- Tipos memoria permitidos: interes_detectado, desinteres_detectado, dato_explotacion, pregunta_usuario, mensaje_libre, evento_estacional, respuesta_exploracion.
- Responde por WhatsApp solo si el mensaje trata claramente de Ruralicos, alertas, ayudas, boletines, PAC, actividad agraria/ganadera o soporte del servicio.
- Si el mensaje es charla social, una pregunta general no relacionada, una broma, un saludo ampliado o cualquier tema fuera de Ruralicos/campo/alertas, usa intencion "otro", requiere_respuesta false y respuesta "".
- Si solo da feedback simple, requiere_respuesta false.
- Si respondes, hazlo sobrio y directo. No uses nombre y apellidos, ni saludos largos, ni despedidas creativas, ni frases tipo "que tengas buen dia en tu granja/campo/con tus animales".
`.trim();

  try {
    const texto = await llamarIA(
      prompt,
      'Devuelve solo JSON valido. Sin markdown, sin explicaciones.',
      'gpt-4o-mini'
    );
    const interpretacion = normalizarInterpretacion(parsearJSON(texto));
    return reforzarInterpretacionConReglasLocales(interpretacion, mensajeUsuario, alertasDelDigest);
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
Resume en un parrafo conciso lo que sabemos de esta persona usuaria de Ruralicos.

Datos registro:
- Nombre: ${usuario?.name || ''}
- Preferencias: ${JSON.stringify(usuario?.preferences || {})}
- Texto libre: ${usuario?.preferencias_extra || 'nada'}

Memoria acumulada:
${memoriasTexto || 'Sin memoria acumulada.'}

Debe ser factual, especifico y util para futuras conversaciones.
No inventes que es agricultor si sus preferencias indican solo ganaderia, ni que es ganadero si indican solo agricultura.
Usa una formulacion neutra si no hay certeza: "Paula tiene una explotacion/perfil de..." o "Paula esta interesada en...".
Devuelve solo el parrafo.
`.trim();

  return llamarIA(prompt, 'Responde solo con el parrafo.', 'gpt-4o-mini');
}

module.exports = {
  interpretarMensaje,
  generarPreguntaExploracion,
  generarContextoNarrativo,
  normalizarInterpretacion,
  __testing: {
    reforzarInterpretacionConReglasLocales,
    esMensajePreferenciaFutura,
    tieneReferenciaDirectaADigest,
  },
};
