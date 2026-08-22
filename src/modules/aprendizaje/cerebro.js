const { llamarIA, parsearJSON } = require('../../platform/ia/llamarIA');
const { OPENAI_MODELS } = require('../../platform/ia/modelPolicy');
const {
  parsearVotosDigest,
  parsearVotosNaturalesPorAlertas,
  analizarFeedbackCompleto,
  esComentarioTramiteOEspera,
} = require('./feedbackParser');
const { inferirTopic } = require('./atomicMemory');

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
        ...(item.scope_type ? { scope_type: String(item.scope_type).slice(0, 40) } : {}),
        ...(item.scope_value ? { scope_value: String(item.scope_value).slice(0, 180) } : {}),
        ...(item.expires_at ? { expires_at: String(item.expires_at).slice(0, 80) } : {}),
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

  return alertas.map((a, i) => {
    const resumenFinal = String(a.resumen_final || '').trim();
    const resumenDigest = resumenFinal.match(/(?:^|\n)\s*RESUMEN_DIGEST:\s*([^\n]+)/i)?.[1];
    const resumen = String(a.resumen_usado || resumenDigest || a.resumen || resumenFinal || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
    return (
      `Item ${i + 1}: "${a.titulo || 'Sin titulo'}"\n` +
      `Resumen: ${resumen || 'N/A'}\n` +
      `Sector: ${(a.sectores || []).join(', ') || 'N/A'} | Subsector: ${(a.subsectores || []).join(', ') || 'N/A'}\n` +
      `Tipo: ${(a.tipos_alerta || []).join(', ') || 'N/A'} | Provincia: ${(a.provincias || []).join(', ') || 'nacional'}`
    );
  }).join('\n\n');
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
    /\b(recibir|mandadme|enviadme|avisadme|avisame|avisenme|avisarais|avisarme|avisarnos)\b[^.!?]{0,80}\b(avisos?|alertas?|notificaciones?|informacion)\b/.test(texto) ||
    /\b(?:me\s+)?puedes\s+avisar\b/.test(texto) ||
    /\b(me gusta|prefiero|valoro)\s+que\s+me\s+(?:informes?|avises?|mandes?|envies?)\b/.test(texto);
  const exclusion = /\b(no me interesa|no quiero|no me envies|no me mandeis|dejad de|evitar)\b/.test(texto);
  const condicion = /\b(solo|solamente|unicamente)\s+(?:me\s+)?interesa\b|\bme interesa\s+(?:solo|solamente|unicamente)\b/.test(texto);
  const declaracion = /\bme interes(?:a|an)\b|\bme gust(?:a|an)\b|\bprefiero\b/.test(texto);

  return (pideRecibir && /\b(sobre|de|del|para)\b/.test(texto)) || exclusion || condicion || declaracion;
}

function parecePreguntaUsuario(mensajeUsuario) {
  const texto = normalizarTextoCerebro(mensajeUsuario);
  if (!texto) return false;
  return /[?¿]/.test(String(mensajeUsuario || '')) ||
    /^(cuando|donde|como|que|cual|cuanto|por que)\b/.test(texto) ||
    /\b(sabes|sabeis|puedes|podrias|me puedes|hay|existe|sale|pagan|ingresan)\b/.test(texto);
}

function tieneReferenciaDirectaADigest(mensajeUsuario) {
  const texto = normalizarTextoCerebro(mensajeUsuario);
  if (!texto) return false;

  return (
    /[+-]\s*\d{1,2}\b/.test(texto) ||
    /\b\d{1,2}\s*[+-]\b/.test(texto) ||
    /\b(item|items|numero|numeros|alerta|alertas|aviso|avisos|primera|segunda|tercera|cuarta|quinta|sexta|septima|octava|novena|decima|esta|esa|la de|lo de|ambas|todas|todos|ninguna|ninguno|resto)\b/.test(texto)
  );
}

function esConsultaMetaMemoria(mensajeUsuario) {
  const texto = normalizarTextoCerebro(mensajeUsuario);
  return /\b(que has aprendido|que habeis aprendido|que sabes de mi|que recordais? de mi|mis intereses|mis preferencias|tu memoria)\b/.test(texto);
}

function buscarFocoPreguntaEnContexto(contextoReciente = [], alertasDelDigest = []) {
  const totalItems = Array.isArray(alertasDelDigest) ? alertasDelDigest.length : 0;
  const mensajes = Array.isArray(contextoReciente) ? contextoReciente : [];

  for (const item of mensajes.slice().reverse()) {
    if (item?.direccion === 'ruralicos') continue;
    const votos = parsearVotosDigest(item?.texto || item?.text_body || '', totalItems)
      .filter((voto) => Number(voto.valor) !== 0);
    const items = [...new Set(votos.map((voto) => Number(voto.item)).filter(Boolean))];
    if (items.length === 1 && alertasDelDigest[items[0] - 1]?.id) {
      return { scope_type: 'alert', scope_value: String(alertasDelDigest[items[0] - 1].id) };
    }
  }

  for (const direccion of ['usuario', 'ruralicos']) {
    for (const item of mensajes.slice().reverse()) {
      if ((item?.direccion || 'usuario') !== direccion) continue;
      const topic = inferirTopic(item?.texto || item?.text_body || '');
      if (topic !== 'general') return { scope_type: 'topic', scope_value: topic };
    }
  }

  return { scope_type: 'topic', scope_value: 'general' };
}

function construirMemoriaPregunta({ mensajeUsuario, interpretacion, contextoReciente, alertasDelDigest }) {
  if (esConsultaMetaMemoria(mensajeUsuario)) return [];

  const existente = (interpretacion.memoria || []).find((memoria) => memoria.tipo === 'pregunta_usuario');
  const focoActual = inferirTopic(`${existente?.contenido || ''} ${mensajeUsuario || ''}`);
  const scope = focoActual !== 'general'
    ? { scope_type: 'topic', scope_value: focoActual }
    : buscarFocoPreguntaEnContexto(contextoReciente, alertasDelDigest);
  const contenidoBase = String(existente?.contenido || mensajeUsuario || '').trim().slice(0, 500);
  const contenido = scope.scope_type === 'topic' && scope.scope_value !== 'general' && inferirTopic(contenidoBase) === 'general'
    ? `Pregunta relacionada con ${scope.scope_value}: ${contenidoBase}`.slice(0, 500)
    : contenidoBase;

  return contenido ? [{
    tipo: 'pregunta_usuario',
    contenido,
    peso_inicial: Math.min(0.35, Number(existente?.peso_inicial || 0.3)),
    ...scope,
  }] : [];
}

function recuperarFeedbackPrevioDesdeContexto(mensajeUsuario, contextoReciente = [], totalItems = 0) {
  const texto = normalizarTextoCerebro(mensajeUsuario);
  const aportaMotivo = /^(porque|por que|es por|por la|por el)\b/.test(texto) ||
    /\b(otra provincia|zona equivocada|no aplica|no aplicaba|curso|formacion|poco concreto)\b/.test(texto);
  if (!aportaMotivo) return null;

  for (const item of (Array.isArray(contextoReciente) ? contextoReciente : []).slice().reverse()) {
    if (item?.direccion === 'ruralicos') continue;
    const votos = parsearVotosDigest(item?.texto || item?.text_body || '', totalItems)
      .filter((voto) => Number(voto.valor) < 0);
    const items = [...new Set(votos.map((voto) => Number(voto.item)).filter(Boolean))];
    if (items.length === 1) {
      return {
        item_numero: items[0],
        valor: -1,
        confianza: 'alta',
        razon: 'Motivo aportado como continuacion del feedback anterior',
      };
    }
    if (items.length > 1) return null;
  }
  return null;
}

function reforzarInterpretacionConReglasLocales(interpretacion, mensajeUsuario, alertasDelDigest = [], contextoReciente = []) {
  const totalItems = Array.isArray(alertasDelDigest) ? alertasDelDigest.length : 0;
  const preferenciaFutura = esMensajePreferenciaFutura(mensajeUsuario);
  if (parecePreguntaUsuario(mensajeUsuario) && !preferenciaFutura) {
    const referenciasDigest = tieneReferenciaDirectaADigest(mensajeUsuario);
    const feedbacks = referenciasDigest && totalItems > 0 ? [...interpretacion.feedbacks] : [];
    if (referenciasDigest && totalItems > 0) {
      for (const voto of parsearVotosDigest(mensajeUsuario, totalItems)) {
        const feedbackLocal = {
          item_numero: voto.item,
          valor: voto.valor,
          confianza: voto.valor < 0 ? 'media' : 'alta',
          razon: 'Referencia ordinal o numerica validada localmente',
        };
        const indexExistente = feedbacks.findIndex((feedback) => Number(feedback.item_numero) === Number(voto.item));
        if (indexExistente >= 0) feedbacks[indexExistente] = feedbackLocal;
        else feedbacks.push(feedbackLocal);
      }
    }
    const memoriasPregunta = construirMemoriaPregunta({
      mensajeUsuario,
      interpretacion,
      contextoReciente,
      alertasDelDigest,
    });
    return normalizarInterpretacion({
      ...interpretacion,
      feedbacks,
      memoria: memoriasPregunta,
      intencion: 'pregunta',
      resumen_para_log: `${interpretacion.resumen_para_log || ''} Pregunta guardada como senal de interes debil.`.trim(),
    });
  }

  if (totalItems <= 0) {
    return normalizarInterpretacion({
      ...interpretacion,
      feedbacks: [],
      memoria: preferenciaFutura ? interpretacion.memoria : [],
      intencion: preferenciaFutura && (interpretacion.memoria || []).length > 0
        ? 'conversacion'
        : interpretacion.intencion,
      resumen_para_log: preferenciaFutura
        ? interpretacion.resumen_para_log
        : `${interpretacion.resumen_para_log || ''} Sin digest ni preferencia explicita: memoria descartada.`.trim(),
    });
  }

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
  const votosNumericos = parsearVotosDigest(mensajeUsuario, totalItems)
    .map((voto) => ({ ...voto, determinista: true }));
  const referenciaDigest = tieneReferenciaDirectaADigest(mensajeUsuario) || votosNumericos.length > 0;
  const votosNaturales = referenciaDigest
    ? (parsearVotosNaturalesPorAlertas(mensajeUsuario, alertasDelDigest).votos || [])
    : [];
  const votosLocales = [...votosNumericos, ...votosNaturales];

  if (feedbacks.length === 0 && votosLocales.length === 0) {
    const feedbackPrevio = recuperarFeedbackPrevioDesdeContexto(mensajeUsuario, contextoReciente, totalItems);
    if (feedbackPrevio) votosLocales.push({
      item: feedbackPrevio.item_numero,
      valor: feedbackPrevio.valor,
      razon: feedbackPrevio.razon,
      confianza: feedbackPrevio.confianza,
    });
  }

  for (const voto of votosLocales) {
    const feedbackLocal = {
      item_numero: voto.item,
      valor: voto.valor,
      confianza: voto.confianza || (voto.valor === -1 ? 'media' : 'alta'),
      razon: voto.razon || (voto.tema
        ? `Regla local: detectado tema ${voto.tema}`
        : 'Regla local: referencia explicita validada'),
    };
    const indexExistente = feedbacks.findIndex((feedback) => Number(feedback.item_numero) === Number(voto.item));
    if (indexExistente >= 0) {
      if (voto.determinista) feedbacks[indexExistente] = feedbackLocal;
      continue;
    }
    feedbacks.push(feedbackLocal);
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

  if (!referenciaDigest && votosLocales.length === 0) {
    return normalizarInterpretacion({
      ...interpretacion,
      feedbacks: [],
      memoria,
      intencion: memoria.length > 0 ? 'conversacion' : 'otro',
      resumen_para_log: `${interpretacion.resumen_para_log || ''} Sin referencia a un item: preferencia guardada sin votar el digest.`.trim(),
    });
  }

  // Una preferencia tematica no debe votar el digest solo por contener palabras
  // como "alertas" o "avisos". Unicamente conservamos feedback cuando hay una
  // referencia determinista a un item concreto (numero u ordinal).
  if (preferenciaFutura && votosNumericos.length === 0) {
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

async function interpretacionFallback({ mensajeUsuario, alertasDelDigest, contextoReciente = [] }) {
  const totalItems = Array.isArray(alertasDelDigest) ? alertasDelDigest.length : 0;
  let votos = parsearVotosDigest(mensajeUsuario, totalItems);

  if (votos.length === 0 && totalItems > 0 && tieneReferenciaDirectaADigest(mensajeUsuario)) {
    const natural = parsearVotosNaturalesPorAlertas(mensajeUsuario, alertasDelDigest);
    votos = natural.votos || [];
  }

  const analisis = await analizarFeedbackCompleto(mensajeUsuario);
  const esPregunta = parecePreguntaUsuario(mensajeUsuario);

  return reforzarInterpretacionConReglasLocales(normalizarInterpretacion({
    feedbacks: votos.map((voto) => ({
      item_numero: voto.item,
      valor: voto.valor,
      confianza: 'alta',
      razon: voto.tema ? `Detectado tema ${voto.tema}` : 'Formato local interpretado sin LLM',
    })),
    memoria: [
      ...(esPregunta ? [{
        tipo: 'pregunta_usuario',
        contenido: String(mensajeUsuario || '').trim().slice(0, 500),
        peso_inicial: 0.3,
      }] : []),
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
    intencion: esPregunta ? 'pregunta' : votos.length > 0 ? 'feedback' : 'otro',
    resumen_para_log: votos.length > 0
      ? `Fallback local: ${votos.length} feedback(s)`
      : 'Fallback local sin feedback numerico',
  }), mensajeUsuario, alertasDelDigest, contextoReciente);
}

function formatearContextoReciente(contextoReciente = []) {
  const mensajes = (Array.isArray(contextoReciente) ? contextoReciente : [])
    .map((item) => {
      const texto = String(item?.texto || item?.text_body || item || '').replace(/\s+/g, ' ').trim();
      if (!texto) return null;
      const direccion = item?.direccion === 'ruralicos' ? 'RURALICOS' : 'USUARIO';
      return `${direccion}: ${texto}`;
    })
    .filter(Boolean);
  return mensajes.length > 0
    ? mensajes.join('\n')
    : 'No hay mensajes recientes relacionados.';
}

async function interpretarMensaje({ mensajeUsuario, usuario, conversacionActiva, alertasDelDigest, contextoReciente = [] }) {
  const contextoUsuario = usuario?.contexto_narrativo || usuario?.preferencias_extra || 'Usuario nuevo sin historial.';
  const prompt = `
Eres el cerebro de Ruralicos, una plataforma espanola de alertas agricolas personalizadas.
Interpreta el mensaje del usuario con maxima comprension y sin inventar datos.

PERFIL DEL USUARIO
Nombre: ${usuario?.name || 'Sin nombre'}
Plan: ${usuario?.subscription || 'desconocido'}
Memoria/contexto: ${contextoUsuario}

CONVERSACION ACTIVA
${conversacionActiva
    ? `Tipo: ${conversacionActiva.tipo || 'desconocido'}\nContexto: ${JSON.stringify(conversacionActiva.contexto_json || {})}`
    : 'No hay conversacion activa.'}

CONVERSACION ASOCIADA AL DIGEST, EN ORDEN
${formatearContextoReciente(contextoReciente)}

ALERTAS DEL DIGEST
${formatearAlertas(alertasDelDigest)}

MENSAJE DEL USUARIO
"${mensajeUsuario}"

Devuelve exactamente JSON valido:
{
  "feedbacks": [],
  "memoria": [],
  "requiere_respuesta": false,
  "respuesta": "",
  "intencion": "otro",
  "resumen_para_log": "Mensaje sin acciones"
}

Reglas:
- Si responde a una pregunta de exploracion, entiende la respuesta completa: condiciones, excepciones, temporadas, tipos de ayuda, cultivos y cualquier otro matiz. No la reduzcas a si/no.
- En una respuesta con "si, pero...", guarda por separado lo que le interesa y lo que no. No conviertas una excepcion concreta en rechazo de todo el tema.
- Cuando la conversacion activa sea pregunta_exploracion, trata la respuesta como memoria de preferencias. No crees feedback del digest salvo que valore explicitamente un item numerado o una alerta concreta.
- Si no expresa una preferencia clara, no inventes memoria. Puede responder con sus propias palabras y no tiene obligacion de decidir en ese momento.
- Una pregunta no es una preferencia firme, pero si una senal de interes debil. Usa intencion "pregunta" y guarda una sola memoria pregunta_usuario que resuma el tema concreto con peso_inicial 0.3. Si ademas expresa interes o desinteres explicitamente, guarda tambien esa preferencia con el peso que corresponda.
- Si una pregunta corta continua el turno anterior ("y la semana pasada", "de esas", "y que documentos"), conserva el tema y las alertas de la ultima respuesta visible. No vuelvas automaticamente al digest original.
- Si MIA acaba de pedir el motivo de un rechazo, asocia la explicacion solo con el ultimo item rechazado de forma explicita.
- No copies contenido de ejemplos ni del perfil como memoria nueva. Toda memoria debe estar demostrada literalmente por el mensaje actual o por una respuesta a pregunta_exploracion.
- feedbacks solo sobre items del digest.
- valor: 1 interesa, -1 no interesa, 0 neutro.
- confianza: alta, media o baja.
- Entiende "la primera", "la de olivos", "la del porcino", "ambas", "ninguna", "+1", "-2".
- Si el usuario dice "me interesa 2 y 3, el resto no/no tanto/no me interesa tanto", marca 2 y 3 como positivos y los demas items del digest como negativos con confianza media.
- Solo crea feedback del digest cuando el mensaje identifica el digest, una alerta o un item. Una preferencia tematica general se guarda como memoria, no como voto de las alertas del digest.
- "No me interesa tanto" es una senal negativa suave: guardala como feedback negativo de confianza media y como desinteres_detectado, no la ignores.
- Si el usuario pide recibir avisos, alertas o informacion sobre temas futuros ("quiero recibir avisos sobre PAC", "me gustaria que me avisarais de tractores"), NO lo conviertas en feedback del digest salvo que mencione claramente un item o una alerta del digest. Guardalo solo como memoria/interes_detectado.
- memoria solo si hay informacion util para el futuro.
- Tipos memoria permitidos: interes_detectado, desinteres_detectado, dato_explotacion, pregunta_usuario, mensaje_libre, evento_estacional, respuesta_exploracion.
- Responde por WhatsApp solo si el mensaje trata claramente de Ruralicos, alertas, ayudas, boletines, PAC, actividad agraria/ganadera o soporte del servicio.
- Si el mensaje es charla social, una pregunta general no relacionada, una broma, un saludo ampliado o cualquier tema fuera de Ruralicos/campo/alertas, usa intencion "otro", requiere_respuesta false y respuesta "".
- Si solo da feedback simple, requiere_respuesta false; la politica anadira un acuse breve despues de guardarlo.
- Si respondes, hazlo sobrio y directo. No uses nombre y apellidos, ni saludos largos, ni despedidas creativas, ni frases tipo "que tengas buen dia en tu granja/campo/con tus animales".
`.trim();

  try {
    const texto = await llamarIA(
      prompt,
      'Devuelve solo JSON valido. Sin markdown, sin explicaciones.',
      OPENAI_MODELS.economy,
      { task: 'cerebro_feedback' }
    );
    const interpretacion = normalizarInterpretacion(parsearJSON(texto));
    return reforzarInterpretacionConReglasLocales(interpretacion, mensajeUsuario, alertasDelDigest, contextoReciente);
  } catch (err) {
    console.warn('[cerebro] Fallback local por error interpretando mensaje:', err.message);
    const fallback = await interpretacionFallback({ mensajeUsuario, alertasDelDigest, contextoReciente });
    fallback.resumen_para_log = `${fallback.resumen_para_log}. Error LLM: ${err.message.slice(0, 160)}`;
    return fallback;
  }
}

async function generarPreguntaExploracion(usuario, zonaIncertidumbre) {
  const prompt = `
Eres el asistente de Ruralicos. Necesitas hacer UNA pregunta corta a ${usuario?.name || 'este usuario'}
para entender mejor sus intereses agricolas.

Lo que sabes: ${usuario?.contexto_narrativo || usuario?.preferencias_extra || 'usuario nuevo'}
Incertidumbre: ${typeof zonaIncertidumbre === 'string'
    ? zonaIncertidumbre
    : JSON.stringify(zonaIncertidumbre || {})}

Devuelve solo una pregunta natural de WhatsApp, maximo 2 frases.
`.trim();

  return llamarIA(prompt, 'Responde solo con el texto de la pregunta.', OPENAI_MODELS.economy, { task: 'cerebro_exploracion' });
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

  return llamarIA(prompt, 'Responde solo con el parrafo.', OPENAI_MODELS.economy, { task: 'cerebro_contexto' });
}

module.exports = {
  interpretarMensaje,
  generarPreguntaExploracion,
  generarContextoNarrativo,
  normalizarInterpretacion,
  __testing: {
    reforzarInterpretacionConReglasLocales,
    esMensajePreferenciaFutura,
    parecePreguntaUsuario,
    tieneReferenciaDirectaADigest,
  },
};
