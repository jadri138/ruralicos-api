// src/routes/alertas.js
const { checkCronToken } = require('../utils/checkCronToken');
const { llamarIA, parsearJSON } = require('../utils/llamarIA');
const { enviarWhatsAppResumen } = require('../whatsapp');
const { getFechaMadridISO } = require('../utils/fechaMadrid');
const { requireAdmin } = require('../../authMiddleware');
const DIGEST_ONLY_MODE = (process.env.DIGEST_ONLY_MODE || 'true').toLowerCase() !== 'false';
const CLASIFICAR_BATCH_SIZE = Number(process.env.CLASIFICAR_BATCH_SIZE || 8);
const RESUMIR_BATCH_SIZE = Number(process.env.RESUMIR_BATCH_SIZE || 5);
const REVISAR_BATCH_SIZE = Number(process.env.REVISAR_BATCH_SIZE || 5);
const CLASIFICAR_LOCAL_FALLBACK = (process.env.CLASIFICAR_LOCAL_FALLBACK || 'true').toLowerCase() !== 'false';
const RESUMIR_LOCAL_FALLBACK = (process.env.RESUMIR_LOCAL_FALLBACK || 'true').toLowerCase() !== 'false';
const REVISAR_LOCAL_FALLBACK = (process.env.REVISAR_LOCAL_FALLBACK || 'true').toLowerCase() !== 'false';
const REVISAR_IA_RESCUE = (process.env.REVISAR_IA_RESCUE || 'false').toLowerCase() === 'true';

const CLASIFICACION_TEXT_FORMAT = {
  type: 'json_schema',
  name: 'clasificacion_alertas',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['resultados'],
    properties: {
      resultados: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'es_relevante', 'provincias', 'sectores', 'subsectores', 'tipos_alerta'],
          properties: {
            id: { type: 'string' },
            es_relevante: { type: 'boolean' },
            provincias: { type: 'array', items: { type: 'string' } },
            sectores: {
              type: 'array',
              items: { type: 'string', enum: ['ganaderia', 'agricultura', 'mixto', 'otros'] },
            },
            subsectores: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'ovino', 'vacuno', 'caprino', 'porcino', 'avicultura', 'cunicultura',
                  'equinocultura', 'apicultura', 'trigo', 'cebada', 'cereal', 'maiz',
                  'arroz', 'hortalizas', 'frutales', 'olivar', 'trufas', 'vinedo',
                  'almendro', 'citricos', 'frutos_secos', 'leguminosas', 'patata',
                  'forrajes', 'forestal', 'agua', 'energia', 'medio_ambiente',
                ],
              },
            },
            tipos_alerta: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['ayudas_subvenciones', 'normativa_general', 'agua_infraestructuras', 'fiscalidad', 'medio_ambiente'],
              },
            },
          },
        },
      },
    },
  },
};

const FICHA_IA_TEXT_FORMAT = {
  type: 'json_schema',
  name: 'fichas_alertas',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['resultados'],
    properties: {
      resultados: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'tipo', 'prioridad', 'territorio', 'afecta_a', 'hecho', 'objeto', 'impacto', 'plazo', 'accion', 'detalle', 'claves'],
          properties: {
            id: { type: 'string' },
            tipo: {
              type: 'string',
              enum: ['ayudas_subvenciones', 'normativa_general', 'agua_infraestructuras', 'fiscalidad', 'medio_ambiente', 'otro'],
            },
            prioridad: { type: 'string', enum: ['alta', 'media', 'baja'] },
            territorio: { type: 'string' },
            afecta_a: { type: 'string' },
            hecho: { type: 'string' },
            objeto: { type: 'string' },
            impacto: { type: 'string' },
            plazo: { type: 'string' },
            accion: { type: 'string' },
            detalle: { type: 'string' },
            claves: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

function hasCronToken(req) {
  const authHeader = String(req.get('authorization') || '');
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const token = req.query.token || req.get('x-cron-token') || bearerToken;

  return Boolean(process.env.CRON_TOKEN && token === process.env.CRON_TOKEN);
}

function requireAdminOrCron(req, res, next) {
  if (hasCronToken(req)) return next();
  return requireAdmin(req, res, next);
}

function validarFechaISO(fecha) {
  return typeof fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fecha);
}

function leerLimiteAlertas(valor) {
  if (valor === undefined) return null;
  const limite = Number.parseInt(valor, 10);
  if (!Number.isFinite(limite) || limite < 1) return null;
  return Math.min(limite, 1000);
}

function normalizarTexto(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function contieneAlguno(texto, palabras) {
  return palabras.some((palabra) => texto.includes(normalizarTexto(palabra)));
}

function limpiarArrayStrings(valor) {
  if (!Array.isArray(valor)) return [];
  return valor
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function limpiarArrayEnum(valor, permitidos) {
  const allowed = new Set(permitidos);
  return Array.from(new Set(
    limpiarArrayStrings(valor)
      .map((item) => normalizarTexto(item).replace(/\s+/g, '_'))
      .filter((item) => allowed.has(item))
  ));
}

function leerBooleano(valor) {
  if (typeof valor === 'boolean') return valor;
  if (typeof valor === 'string') {
    return ['true', '1', 'si', 'sí', 'yes', 'relevante'].includes(valor.trim().toLowerCase());
  }
  return Boolean(valor);
}

function extraerResultadosClasificacion(parsed) {
  if (Array.isArray(parsed?.resultados)) return parsed.resultados;
  if (Array.isArray(parsed)) return parsed;
  return [];
}

function clasificarLocalmente(alerta) {
  const texto = normalizarTexto(`${alerta.titulo || ''}\n${alerta.region || ''}\n${alerta.contenido || ''}`);

  const ganaderia = contieneAlguno(texto, [
    'ganader', 'vacuno', 'bovino', 'ovino', 'caprino', 'porcino', 'avicola',
    'aves', 'apicultura', 'colmena', 'sanidad animal', 'bienestar animal',
  ]);
  const agricultura = contieneAlguno(texto, [
    'agricultur', 'agrari', 'cultivo', 'explotacion agraria', 'olivar',
    'vinedo', 'vitivinicol', 'cereal', 'trigo', 'cebada', 'maiz', 'arroz',
    'hortaliza', 'frutal', 'almendro', 'citric', 'fitosanit', 'sanidad vegetal',
    'plaga', 'fertiliz', 'cuaderno de campo',
  ]);
  const rural = contieneAlguno(texto, [
    'pac', 'fega', 'sigpac', 'regadio', 'riego', 'regante', 'comunidad de regantes',
    'agua', 'forestal', 'monte', 'medio ambiente', 'agroalimentari', 'cooperativa agraria',
  ]);
  const ayuda = contieneAlguno(texto, ['ayuda', 'subvencion', 'convocatoria', 'bases reguladoras', 'beneficiario']);
  const fiscalidad = contieneAlguno(texto, ['irpf', 'iva', 'modulos', 'fiscal', 'tributari']);
  const exclusionAdministrativa = contieneAlguno(texto, [
    'oposicion', 'proceso selectivo', 'bolsa de empleo', 'universidad', 'beca',
    'notario', 'registrador', 'urbanismo',
  ]);
  const pescaAcuicultura = contieneAlguno(texto, ['pesca', 'acuicultura']);
  const exclusionFuerte = exclusionAdministrativa || (pescaAcuicultura && !ganaderia && !agricultura && !rural);

  const esRelevante = (ganaderia || agricultura || rural) && !exclusionFuerte;
  if (!esRelevante) {
    return {
      id: String(alerta.id),
      es_relevante: false,
      provincias: [],
      sectores: [],
      subsectores: [],
      tipos_alerta: [],
    };
  }

  const sectores = [];
  if (ganaderia && agricultura) sectores.push('mixto');
  else if (ganaderia) sectores.push('ganaderia');
  else if (agricultura) sectores.push('agricultura');
  else sectores.push('otros');

  const subsectores = [];
  const addSubsector = (value, words) => {
    if (contieneAlguno(texto, words)) subsectores.push(value);
  };
  addSubsector('ovino', ['ovino', 'oveja', 'cordero']);
  addSubsector('vacuno', ['vacuno', 'bovino', 'vaca']);
  addSubsector('caprino', ['caprino', 'cabra']);
  addSubsector('porcino', ['porcino', 'cerdo']);
  addSubsector('avicultura', ['avicola', 'aves', 'gallina']);
  addSubsector('apicultura', ['apicultura', 'abeja', 'colmena']);
  addSubsector('trigo', ['trigo']);
  addSubsector('cebada', ['cebada']);
  addSubsector('cereal', ['cereal']);
  addSubsector('maiz', ['maiz']);
  addSubsector('arroz', ['arroz']);
  addSubsector('hortalizas', ['hortaliza']);
  addSubsector('frutales', ['frutal', 'fruta']);
  addSubsector('olivar', ['olivar', 'aceituna']);
  addSubsector('vinedo', ['vinedo', 'vitivinicol', 'uva', 'vino']);
  addSubsector('almendro', ['almendro']);
  addSubsector('citricos', ['citrico', 'naranja', 'limon']);
  addSubsector('frutos_secos', ['frutos secos', 'pistacho', 'avellana']);
  addSubsector('forestal', ['forestal', 'monte']);
  addSubsector('agua', ['agua', 'riego', 'regadio', 'regante']);
  addSubsector('energia', ['energia', 'fotovoltaic', 'biomasa']);
  addSubsector('medio_ambiente', ['medio ambiente', 'ambiental', 'biodiversidad']);

  const tipos_alerta = [];
  if (ayuda) tipos_alerta.push('ayudas_subvenciones');
  if (rural && contieneAlguno(texto, ['agua', 'riego', 'regadio', 'regante'])) tipos_alerta.push('agua_infraestructuras');
  if (fiscalidad) tipos_alerta.push('fiscalidad');
  if (contieneAlguno(texto, ['medio ambiente', 'ambiental', 'biodiversidad', 'forestal'])) tipos_alerta.push('medio_ambiente');
  if (tipos_alerta.length === 0) tipos_alerta.push('normativa_general');

  return {
    id: String(alerta.id),
    es_relevante: true,
    provincias: [],
    sectores: Array.from(new Set(sectores)),
    subsectores: Array.from(new Set(subsectores)),
    tipos_alerta: Array.from(new Set(tipos_alerta)),
  };
}

function normalizarResultadoClasificacion(item, alertasPorId) {
  const id = item?.id === undefined || item?.id === null ? '' : String(item.id);
  if (!id || !alertasPorId.has(id)) return null;
  if (item.es_relevante === undefined || item.es_relevante === null) return null;

  const esRelevante = leerBooleano(item.es_relevante);
  if (!esRelevante) {
    return {
      id,
      es_relevante: false,
      provincias: [],
      sectores: [],
      subsectores: [],
      tipos_alerta: [],
    };
  }

  return {
    id,
    es_relevante: true,
    provincias: limpiarArrayStrings(item.provincias),
    sectores: limpiarArrayEnum(item.sectores, ['ganaderia', 'agricultura', 'mixto', 'otros']),
    subsectores: limpiarArrayEnum(item.subsectores, [
      'ovino', 'vacuno', 'caprino', 'porcino', 'avicultura', 'cunicultura',
      'equinocultura', 'apicultura', 'trigo', 'cebada', 'cereal', 'maiz',
      'arroz', 'hortalizas', 'frutales', 'olivar', 'trufas', 'vinedo',
      'almendro', 'citricos', 'frutos_secos', 'leguminosas', 'patata',
      'forrajes', 'forestal', 'agua', 'energia', 'medio_ambiente',
    ]),
    tipos_alerta: limpiarArrayEnum(item.tipos_alerta, [
      'ayudas_subvenciones', 'normativa_general', 'agua_infraestructuras',
      'fiscalidad', 'medio_ambiente',
    ]),
  };
}

function limpiarTextoMensaje(texto, max = 420) {
  return String(texto || '')
    .replace(/\s+/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .trim()
    .slice(0, max)
    .trim();
}

function construirMensajeFallback(alerta) {
  const titulo = limpiarTextoMensaje(alerta.titulo, 220) || 'Publicacion oficial detectada';
  const contexto = limpiarTextoMensaje(alerta.contenido, 260);
  const territorio = limpiarTextoMensaje(
    Array.isArray(alerta.provincias) && alerta.provincias.length
      ? alerta.provincias.join(', ')
      : alerta.region,
    120
  ) || 'no_detectado';
  const tipo = limpiarTextoMensaje(
    Array.isArray(alerta.tipos_alerta) && alerta.tipos_alerta.length
      ? alerta.tipos_alerta.join(', ')
      : '',
    120
  ) || 'normativa_general';
  const sectores = limpiarTextoMensaje(
    Array.isArray(alerta.sectores) && alerta.sectores.length
      ? alerta.sectores.join(', ')
      : '',
    120
  ) || 'sector_agrario';
  const fecha = limpiarTextoMensaje(alerta.fecha, 20) || 'El boletin no lo especifica';

  return [
    'FICHA_IA',
    `TIPO: ${tipo}`,
    'PRIORIDAD: media',
    `TERRITORIO: ${territorio}`,
    `AFECTA_A: ${sectores}`,
    `HECHO: ${contexto || titulo}`,
    `OBJETO: ${titulo}`,
    'IMPACTO: no_detectado',
    'PLAZO: no_detectado',
    `ACCION: revisar documento oficial publicado el ${fecha}`,
    'DETALLE: revisar si aplica a la explotacion o actividad del usuario',
    `CLAVES: ${titulo}`,
  ].join('\n').slice(0, 1400).trim();
}

function limpiarMensajeFinal(mensaje, alerta = {}) {
  const texto = String(mensaje || '').trim();
  if (texto) return normalizarFichaIA(texto, alerta).texto;
  return construirMensajeFallback(alerta);
}

const FICHA_CAMPOS_REQUERIDOS = ['tipo', 'prioridad', 'territorio', 'afecta_a', 'hecho', 'objeto', 'impacto', 'plazo', 'accion', 'detalle', 'claves'];
const FICHA_TIPOS = new Set(['ayudas_subvenciones', 'normativa_general', 'agua_infraestructuras', 'fiscalidad', 'medio_ambiente', 'otro']);
const FICHA_PRIORIDADES = new Set(['alta', 'media', 'baja']);

function limpiarCampoFicha(texto, max = 160) {
  return String(texto || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

function limitarPalabras(texto, maxPalabras, maxChars) {
  const limpio = limpiarCampoFicha(texto, maxChars);
  const palabras = limpio.split(/\s+/).filter(Boolean);
  if (palabras.length <= maxPalabras) return limpio;
  return palabras.slice(0, maxPalabras).join(' ');
}

function primerArray(valor) {
  return Array.isArray(valor) && valor.length > 0 ? valor[0] : '';
}

function normalizarTipoFicha(valor) {
  const raw = normalizarTexto(valor).replace(/\s+/g, '_');
  if (FICHA_TIPOS.has(raw)) return raw;
  if (/ayuda|subvencion|convocatoria|pac|fega|feader|feaga/.test(raw)) return 'ayudas_subvenciones';
  if (/agua|riego|regadio|infraestructura|concesion/.test(raw)) return 'agua_infraestructuras';
  if (/irpf|iva|fiscal|tribut/.test(raw)) return 'fiscalidad';
  if (/ambient|forestal|biodiversidad|monte/.test(raw)) return 'medio_ambiente';
  if (/norma|orden|decreto|resolucion/.test(raw)) return 'normativa_general';
  return 'otro';
}

function normalizarPrioridadFicha(valor) {
  const raw = normalizarTexto(valor);
  if (FICHA_PRIORIDADES.has(raw)) return raw;
  if (/urgente|alta|plazo|finaliza|termina|antes del|alegacion/.test(raw)) return 'alta';
  if (/baja|informativo|menor|para revisar/.test(raw)) return 'baja';
  return 'media';
}

function normalizarClavesFicha(valor, fallback = '') {
  const items = Array.isArray(valor)
    ? valor
    : String(valor || '').split(/[,;|]/g);

  const claves = items
    .map((item) => limpiarCampoFicha(item, 36))
    .filter(Boolean)
    .slice(0, 8);

  if (claves.length > 0) return claves;

  const fallbackClaves = normalizarTexto(fallback)
    .split(/\s+/)
    .filter((palabra) => palabra.length >= 4)
    .slice(0, 6);
  return fallbackClaves.length > 0 ? fallbackClaves : ['alerta_oficial'];
}

function construirFichaIA(data = {}, alerta = {}) {
  const titulo = limpiarCampoFicha(alerta.titulo, 180) || 'Publicacion oficial detectada';
  const territorioBase = Array.isArray(alerta.provincias) && alerta.provincias.length
    ? alerta.provincias.join(', ')
    : alerta.region;
  const sectoresBase = Array.isArray(alerta.sectores) && alerta.sectores.length
    ? alerta.sectores.join(', ')
    : 'sector_agrario';

  const ficha = {
    tipo: normalizarTipoFicha(data.tipo || primerArray(alerta.tipos_alerta)),
    prioridad: normalizarPrioridadFicha(data.prioridad || data.hecho || titulo),
    territorio: limpiarCampoFicha(data.territorio || territorioBase || 'no_detectado', 120) || 'no_detectado',
    afecta_a: limitarPalabras(data.afecta_a || sectoresBase, 12, 120) || 'sector_agrario',
    hecho: limitarPalabras(data.hecho || alerta.contenido || titulo, 32, 280) || titulo,
    objeto: limitarPalabras(data.objeto || titulo, 24, 220) || titulo,
    impacto: limitarPalabras(data.impacto || 'no_detectado', 26, 240) || 'no_detectado',
    plazo: limpiarCampoFicha(data.plazo || 'no_detectado', 80) || 'no_detectado',
    accion: limitarPalabras(data.accion || 'revisar documento oficial', 18, 170) || 'revisar documento oficial',
    detalle: limitarPalabras(data.detalle || 'no_detectado', 34, 300) || 'no_detectado',
    claves: normalizarClavesFicha(data.claves, titulo),
  };

  return [
    'FICHA_IA',
    `TIPO: ${ficha.tipo}`,
    `PRIORIDAD: ${ficha.prioridad}`,
    `TERRITORIO: ${ficha.territorio}`,
    `AFECTA_A: ${ficha.afecta_a}`,
    `HECHO: ${ficha.hecho}`,
    `OBJETO: ${ficha.objeto}`,
    `IMPACTO: ${ficha.impacto}`,
    `PLAZO: ${ficha.plazo}`,
    `ACCION: ${ficha.accion}`,
    `DETALLE: ${ficha.detalle}`,
    `CLAVES: ${ficha.claves.join(', ')}`,
  ].join('\n').slice(0, 1400).trim();
}

function parsearFichaIA(texto) {
  const parsed = {};
  const lineas = String(texto || '').split(/\r?\n/g);

  for (const linea of lineas) {
    const match = linea.match(/^([A-Z_]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    parsed[key] = match[2].trim();
  }

  if (Object.keys(parsed).length === 0) return null;
  if (parsed.claves) parsed.claves = parsed.claves.split(/[,;|]/g).map((item) => item.trim()).filter(Boolean);
  return parsed;
}

function normalizarFichaIA(texto, alerta = {}) {
  const parsed = typeof texto === 'object' && texto !== null ? texto : parsearFichaIA(texto);
  const validaOriginal = Boolean(parsed && FICHA_CAMPOS_REQUERIDOS.every((campo) => {
    const valor = parsed[campo];
    return Array.isArray(valor) ? valor.length > 0 : Boolean(String(valor || '').trim());
  }));

  return {
    texto: construirFichaIA(parsed || {}, alerta),
    validaOriginal,
  };
}

function extraerResultadosFichaIA(parsed) {
  if (Array.isArray(parsed?.resultados)) return parsed.resultados;
  if (Array.isArray(parsed)) return parsed;
  return [];
}

function normalizarResultadoFichaIA(item, alertasPorId) {
  const id = item?.id === undefined || item?.id === null ? '' : String(item.id);
  if (!id || !alertasPorId.has(id)) return null;
  return {
    id,
    ficha: construirFichaIA(item, alertasPorId.get(id)),
  };
}

function buildPromptFichasIA(lista) {
  return `
Convierte cada alerta agraria en una ficha esquematica para otra IA.
No escribas mensajes para WhatsApp. No embellezcas. No metas emojis.

Campos por alerta:
- id: ID real de la alerta
- tipo: ayudas_subvenciones | normativa_general | agua_infraestructuras | fiscalidad | medio_ambiente | otro
- prioridad: alta | media | baja
- territorio: provincia/CCAA/estatal/no_detectado
- afecta_a: colectivo agrario afectado en maximo 12 palabras; se especifico: agricultores, ganaderos, regantes, viticultores, explotaciones, industria agroalimentaria, titulares concretos, etc.
- hecho: que ocurre realmente en maximo 32 palabras. No copies la cabecera del boletin; extrae el acto sustantivo.
- objeto: tema concreto de la publicacion en maximo 24 palabras: ayuda, norma, exposicion publica, autorizacion, sancion, modificacion, convocatoria, etc.
- impacto: por que puede importar al usuario agrario en maximo 26 palabras; si solo afecta a un titular o expediente individual, dilo.
- plazo: fecha/plazo si aparece; si no, no_detectado
- accion: accion recomendada en maximo 18 palabras
- detalle: dato especifico util en maximo 34 palabras: importe, cultivo/especie, municipio, expediente, requisito, periodo, tramite o limitacion. Si no aparece, no_detectado.
- claves: 3-8 palabras clave

Reglas:
- Lenguaje literal, seco y util para filtrado posterior.
- NO inventar datos que no esten en el texto.
- Si un dato no aparece, usa no_detectado.
- Prioriza el contenido juridico/administrativo real frente a formulas como "Resolucion de..." o nombres de consejerias.
- Si el texto solo anuncia exposicion publica, indica que documento/expediente se expone y a quien afecta.
- No incluyas URL dentro de campos narrativos.
- Debes devolver una ficha por cada ID recibido.

SALIDA: devuelve UNICAMENTE JSON valido con esta forma:
{
  "resultados": [
    {
      "id": "ID real",
      "tipo": "ayudas_subvenciones",
      "prioridad": "media",
      "territorio": "no_detectado",
      "afecta_a": "sector agrario",
      "hecho": "descripcion breve",
      "objeto": "tema concreto",
      "impacto": "por que puede importar",
      "plazo": "no_detectado",
      "accion": "revisar documento oficial",
      "detalle": "dato especifico util",
      "claves": ["palabra1", "palabra2", "palabra3"]
    }
  ]
}

Alertas:
${lista}
`.trim();
}

async function generarFichasIAEnLote(alertas) {
  const alertasPorId = new Map(alertas.map((a) => [String(a.id), a]));
  const resultadosPorId = new Map();
  const errores = [];
  let fallbackLocal = 0;
  let usarFormatoEstructurado = true;

  const instructions = 'Eres un analista experto en boletines agrarios. Devuelve SOLO JSON valido con las fichas compactas solicitadas.';

  const formatarAlerta = (a) => {
    const texto = a.contenido ? a.contenido.slice(0, 2200) : '';
    const provincias = Array.isArray(a.provincias) ? a.provincias.join(', ') : '';
    const sectores = Array.isArray(a.sectores) ? a.sectores.join(', ') : '';
    const subsectores = Array.isArray(a.subsectores) ? a.subsectores.join(', ') : '';
    const tiposAlerta = Array.isArray(a.tipos_alerta) ? a.tipos_alerta.join(', ') : '';
    return [
      `ID=${a.id}`,
      `Fecha=${a.fecha}`,
      `Fuente=${a.fuente || 'boletin'}`,
      `Region=${a.region || 'no_detectado'}`,
      `Provincias=${provincias || 'no_detectado'}`,
      `Sectores=${sectores || 'no_detectado'}`,
      `Subsectores=${subsectores || 'no_detectado'}`,
      `Tipos=${tiposAlerta || 'no_detectado'}`,
      `Titulo=${a.titulo || ''}`,
      `Texto=${texto}`,
    ].join(' | ');
  };

  const llamarGenerador = async (prompt) => {
    const maxOutputTokens = Math.min(6000, Math.max(900, alertas.length * 420 + 400));
    if (!usarFormatoEstructurado) {
      return llamarIA(prompt, instructions, 'gpt-5-nano', { maxOutputTokens });
    }

    try {
      return await llamarIA(prompt, instructions, 'gpt-5-nano', {
        textFormat: FICHA_IA_TEXT_FORMAT,
        maxOutputTokens,
      });
    } catch (err) {
      const mensaje = String(err.message || '');
      const pareceErrorFormato = /json_schema|text\.format|unknown parameter|unsupported|invalid_request/i.test(mensaje);
      if (!pareceErrorFormato) throw err;

      usarFormatoEstructurado = false;
      console.warn('[resumir] Formato JSON estructurado no disponible, reintentando sin text.format:', err.message);
      return llamarIA(prompt, instructions, 'gpt-5-nano', { maxOutputTokens });
    }
  };

  try {
    const lista = alertas.map(formatarAlerta).join('\n\n---\n\n');
    const contenido = await llamarGenerador(buildPromptFichasIA(lista));
    const parsed = parsearJSON(contenido);

    for (const item of extraerResultadosFichaIA(parsed)) {
      const normalizado = normalizarResultadoFichaIA(item, alertasPorId);
      if (normalizado && !resultadosPorId.has(normalizado.id)) {
        resultadosPorId.set(normalizado.id, normalizado);
      }
    }
  } catch (err) {
    errores.push({ fase: 'lote', error: err.message });
    console.error('[resumir] Error generando fichas en lote:', err.message);
  }

  const sinResolver = alertas.filter((a) => !resultadosPorId.has(String(a.id)));
  if (sinResolver.length > 0) {
    errores.push({ fase: 'lote', error: `faltan ${sinResolver.length} fichas` });
  }

  if (RESUMIR_LOCAL_FALLBACK) {
    for (const alerta of sinResolver) {
      resultadosPorId.set(String(alerta.id), {
        id: String(alerta.id),
        ficha: construirMensajeFallback(alerta),
      });
      fallbackLocal++;
    }
  }

  return {
    resultados: Array.from(resultadosPorId.values()),
    errores,
    fallbackLocal,
  };
}

// ─────────────────────────────────────────────
// Helper: construir prompt de clasificación para 1 o N alertas
// ─────────────────────────────────────────────
function buildPromptClasificar(lista) {
  return `
Te paso una lista de alertas de boletines oficiales. Para CADA una debes:

1) Decidir si es RELEVANTE PARA EL SECTOR AGRARIO O GANADERO.

────────────────────────────
✅ SÍ IMPORTA — Una alerta ES relevante si trata sobre:
────────────────────────────
- Agricultores, ganaderos, explotaciones agrarias o ganaderas
- Comunidades de regantes, regadíos, infraestructuras de riego
- Cooperativas agrarias, SAT, industria agroalimentaria
- PAC, FEGA, Solicitud Única, SIGPAC
- Sanidad animal, movimientos de animales, bienestar animal (aunque sea muy técnico)
- Plagas, fitosanitarios, fertilización, cuaderno de campo
- Licitaciones de obras de riego o infraestructuras agrarias
- Vitivinicultura, olivar, frutales, cereal, ganadería específica
- Normativa que afecte directamente a la actividad agrícola o ganadera
- Cursos y formación obligatoria del sector (bienestar animal, transporte, aplicador fitosanitario…)
- Fiscalidad agraria: módulos, IRPF agrario, IVA agropecuario, regímenes especiales del campo
- Normativa medioambiental que afecte directamente a explotaciones agrarias o ganaderas
- Nombramientos de cargos con poder real sobre el sector: Ministro/a de Agricultura, Director/a General PAC, Consejero/a de Agricultura de una CCAA, Presidente/a de organismo agrario nacional o autonómico

────────────────────────────
🚫 NO IMPORTA — Una alerta NO es relevante si:
────────────────────────────
- Es una concesión o ayuda resuelta a favor de un único titular concreto (persona física o empresa individual), SALVO que afecte a una comunidad de regantes, a infraestructura pública agraria, o que abra un procedimiento con plazos de alegaciones que puedan afectar a terceros
- Es convocatoria de oposiciones, bolsa de empleo o proceso selectivo público
- Es nombramiento o cese de cargos administrativos menores: jefes de sección, delegados provinciales, registradores, notarios, funcionarios de oficinas concretas
- Es licitación de obras de construcción, urbanismo o infraestructuras no agrarias
- Es subvención o ayuda generalista para PYMEs/autónomos sin mención al sector agrario
- Trata exclusivamente de pesca o acuicultura
- Es de administración general sin impacto en el campo: becas universitarias, convenios colectivos no agrarios, tasas administrativas generales
- No guarda relación directa ni evidente con la actividad agrícola o ganadera

2) Si ES relevante, clasificarla con:
- "provincias": lista de provincias mencionadas. Si es toda una CCAA → todas sus provincias. Si es estatal → [].
- "sectores": uno o varios de ["ganaderia","agricultura","mixto","otros"]
- "subsectores": uno o varios de ["ovino","vacuno","caprino","porcino","avicultura","cunicultura","equinocultura","apicultura","trigo","cebada","cereal","maiz","arroz","hortalizas","frutales","olivar","trufas","viñedo","almendro","citricos","frutos_secos","leguminosas","patata","forrajes","forestal","agua","energia","medio_ambiente"]
- "tipos_alerta": uno o varios de ["ayudas_subvenciones","normativa_general","agua_infraestructuras","fiscalidad","medio_ambiente"]

SALIDA: devuelve ÚNICAMENTE este JSON válido, sin texto extra:

{
  "resultados": [
    {
      "id": "ID real",
      "es_relevante": true,
      "provincias": [],
      "sectores": [],
      "subsectores": [],
      "tipos_alerta": []
    }
  ]
}

Si NO es relevante → "es_relevante": false y todos los arrays vacíos.

Lista de alertas:
${lista}
`.trim();
}

// ─────────────────────────────────────────────
// Helper: clasificar alertas con reintento individual si falla
// ─────────────────────────────────────────────
async function clasificarConReintento(alertas) {
  const alertasPorId = new Map(alertas.map((a) => [String(a.id), a]));
  const resultadosPorId = new Map();
  const errores = [];
  let fallbackLocal = 0;
  const instructions = 'Eres un clasificador experto del sector agrario español. Responde SOLO con JSON válido, sin explicaciones.';

  let usarFormatoEstructurado = true;

  const llamarClasificador = async (prompt, maxOutputTokens) => {
    if (!usarFormatoEstructurado) {
      return llamarIA(prompt, instructions, 'gpt-5-nano');
    }

    try {
      return await llamarIA(prompt, instructions, 'gpt-5-nano', {
        textFormat: CLASIFICACION_TEXT_FORMAT,
        maxOutputTokens,
      });
    } catch (err) {
      const mensaje = String(err.message || '');
      const pareceErrorFormato = /json_schema|text\.format|unknown parameter|unsupported|invalid_request/i.test(mensaje);
      if (!pareceErrorFormato) throw err;

      usarFormatoEstructurado = false;
      console.warn('[clasificar] Formato JSON estructurado no disponible, reintentando sin text.format:', err.message);
      return llamarIA(prompt, instructions, 'gpt-5-nano');
    }
  };

  const formatarAlerta = (a) => {
    const texto = a.contenido ? a.contenido.slice(0, 3000) : '';
    return `ID=${a.id} | Fecha=${a.fecha} | Region=${a.region} | URL=${a.url} | Titulo=${a.titulo} | Texto=${texto}`;
  };

  const anadirResultados = (parsed) => {
    for (const item of extraerResultadosClasificacion(parsed)) {
      const normalizado = normalizarResultadoClasificacion(item, alertasPorId);
      if (normalizado && !resultadosPorId.has(normalizado.id)) {
        resultadosPorId.set(normalizado.id, normalizado);
      }
    }
  };

  // Intento en lote
  const lista = alertas.map(formatarAlerta).join('\n\n');

  try {
    const contenido = await llamarClasificador(buildPromptClasificar(lista), 4000);
    const parsed = parsearJSON(contenido);
    anadirResultados(parsed);
  } catch (err) {
    errores.push({ fase: 'lote', error: err.message });
    console.error('Error en clasificación en lote, pasando a reintentos individuales:', err.message);
  }

  // Detectar IDs que faltan en la respuesta
  const alertasFallidas = alertas.filter((a) => !resultadosPorId.has(String(a.id)));

  if (alertasFallidas.length > 0) {
    console.warn(`Faltan ${alertasFallidas.length} IDs en la respuesta del lote. Reintentando uno a uno...`);

    for (const alerta of alertasFallidas) {
      try {
        const listaIndividual = formatarAlerta(alerta);
        const contenido = await llamarClasificador(buildPromptClasificar(listaIndividual), 1200);
        const parsed = parsearJSON(contenido);
        const antes = resultadosPorId.size;
        anadirResultados(parsed);
        if (resultadosPorId.size > antes && resultadosPorId.has(String(alerta.id))) {
          continue;
        } else {
          console.warn(`Reintento fallido para ID ${alerta.id}: respuesta no coincide. Se deja pendiente.`);
          errores.push({ fase: 'individual', id: alerta.id, error: 'respuesta no coincide o sin resultado valido' });
          // No se añade → quedará pendiente para el siguiente cron
        }
      } catch (err) {
        console.error(`Error en reintento individual ID ${alerta.id}:`, err.message);
        errores.push({ fase: 'individual', id: alerta.id, error: err.message });
        // Se deja pendiente para el siguiente cron
      }
    }
  }

  const sinResolver = alertas.filter((a) => !resultadosPorId.has(String(a.id)));
  if (CLASIFICAR_LOCAL_FALLBACK && sinResolver.length > 0) {
    console.warn(`[clasificar] Usando fallback local para ${sinResolver.length} alerta(s) sin respuesta valida de IA.`);
    for (const alerta of sinResolver) {
      resultadosPorId.set(String(alerta.id), clasificarLocalmente(alerta));
      fallbackLocal++;
    }
  }

  return {
    resultados: Array.from(resultadosPorId.values()),
    errores,
    fallbackLocal,
  };
}

// ══════════════════════════════════════════════════════════════════════
// SQL PARA SUPABASE (ejecutar una vez en el SQL Editor de Supabase):
//
// ALTER TABLE alertas
//   ADD COLUMN IF NOT EXISTS estado_ia TEXT DEFAULT 'pendiente_clasificar',
//   ADD COLUMN IF NOT EXISTS resumen_borrador TEXT,
//   ADD COLUMN IF NOT EXISTS resumen_final TEXT;
//
// CREATE INDEX IF NOT EXISTS idx_alertas_estado_ia ON alertas(estado_ia);
//
// estados posibles de estado_ia:
//   'pendiente_clasificar' → recién insertada, esperando Paso 1
//   'descartado'           → la IA decidió que no es relevante
//   'pendiente_resumir'    → clasificada como relevante, esperando Paso 2
//   'pendiente_revisar'    → borrador listo, esperando Paso 3
//   'listo'                → revisada y lista para enviar por WhatsApp
// ══════════════════════════════════════════════════════════════════════

module.exports = function alertasRoutes(app, supabase) {

  // ══════════════════════════════════════════
  // 1) Insertar alerta manual
  // ══════════════════════════════════════════
  app.post('/alertas', requireAdminOrCron, async (req, res) => {
    const { titulo, resumen, url, fecha, region, fuente } = req.body;

    if (!titulo || !url || !fecha) {
      return res.status(400).json({ error: 'Faltan campos obligatorios: titulo, url o fecha' });
    }

    const { data, error } = await supabase
      .from('alertas')
      .insert([{
        titulo,
        resumen: resumen ?? null,
        url,
        fecha,
        region,
        fuente: fuente || 'MANUAL',
        estado_ia: 'pendiente_clasificar',
      }])
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, alerta: data[0] });
  });

  // ══════════════════════════════════════════
  // 2) Listar todas las alertas
  // ══════════════════════════════════════════
  app.get('/alertas', requireAdminOrCron, async (req, res) => {
    const fecha = typeof req.query.fecha === 'string' ? req.query.fecha.trim() : '';
    const limit = leerLimiteAlertas(req.query.limit);

    if (fecha && !validarFechaISO(fecha)) {
      return res.status(400).json({ error: 'Parametro fecha invalido. Usa YYYY-MM-DD' });
    }

    let query = supabase
      .from('alertas')
      .select('*')
      .order('created_at', { ascending: false });

    if (fecha) query = query.eq('fecha', fecha);
    if (limit) query = query.limit(limit);

    const { data, error } = await query;

    if (error) return res.status(500).json({ error: error.message });
    res.json({ count: (data || []).length, alertas: data || [] });
  });

  // ══════════════════════════════════════════════════════════════
  // PASO 1 — /alertas/clasificar
  // IA 1: decide relevancia + clasificación. Descarta la paja.
  // Cron recomendado: cada 5-10 minutos durante el horario de ingesta
  // ══════════════════════════════════════════════════════════════
  const clasificarHandler = async (req, res) => {
    try {
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, region, fecha, contenido')
        .eq('estado_ia', 'pendiente_clasificar')
        .order('created_at', { ascending: true })
        .limit(CLASIFICAR_BATCH_SIZE);

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length === 0) {
        return res.json({ success: true, procesadas: 0, mensaje: 'No hay alertas pendientes de clasificar' });
      }

      const {
        resultados,
        errores: erroresClasificacion,
        fallbackLocal,
      } = await clasificarConReintento(alertas);

      let clasificadas = 0;
      let descartadas = 0;
      let actualizadas = 0;
      const erroresUpdate = [];
      const idsActualizados = new Set();

      for (const item of resultados) {
        if (!item.id) continue;

        if (!item.es_relevante) {
          const { error: updError } = await supabase
            .from('alertas')
            .update({
              estado_ia: 'descartado',
              resumen: 'NO IMPORTA',
              provincias: [],
              sectores: [],
              subsectores: [],
              tipos_alerta: [],
            })
            .eq('id', item.id);
          if (updError) {
            erroresUpdate.push({ id: item.id, error: updError.message });
            continue;
          }
          descartadas++;
          actualizadas++;
          idsActualizados.add(String(item.id));
        } else {
          const { error: updError } = await supabase
            .from('alertas')
            .update({
              estado_ia: 'pendiente_resumir',
              provincias: item.provincias ?? [],
              sectores: item.sectores ?? [],
              subsectores: item.subsectores ?? [],
              tipos_alerta: item.tipos_alerta ?? [],
            })
            .eq('id', item.id);
          if (updError) {
            erroresUpdate.push({ id: item.id, error: updError.message });
            continue;
          }
          clasificadas++;
          actualizadas++;
          idsActualizados.add(String(item.id));
        }
      }

      // Las alertas que no aparecen en resultados se quedan en 'pendiente_clasificar'
      // y serán reintentadas en el siguiente cron
      const idsNoResueltos = alertas
        .filter((a) => !idsActualizados.has(String(a.id)))
        .map((a) => a.id);

      res.json({
        success: true,
        procesadas: alertas.length,
        actualizadas,
        clasificadas,
        clasificados: clasificadas,
        descartadas,
        fallback_local: fallbackLocal,
        errores: [...erroresClasificacion, ...erroresUpdate].slice(0, 20),
        pendientes_reintento: idsNoResueltos,
      });

    } catch (err) {
      console.error('Error en /alertas/clasificar', err);
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/alertas/clasificar', (req, res) => {
    if (!checkCronToken(req, res)) return;
    clasificarHandler(req, res);
  });
  app.get('/alertas/clasificar', (req, res) => {
    if (!checkCronToken(req, res)) return;
    clasificarHandler(req, res);
  });

  // ══════════════════════════════════════════════════════════════
  // PASO 2 — /alertas/resumir
  // IA 2: genera una ficha compacta para IA. No clasifica, no decide.
  // Cron recomendado: cada 5-10 minutos durante el horario de ingesta
  // ══════════════════════════════════════════════════════════════
  const resumirHandler = async (req, res) => {
    try {
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, fuente, region, fecha, contenido, provincias, sectores, subsectores, tipos_alerta')
        .eq('estado_ia', 'pendiente_resumir')
        .order('created_at', { ascending: true })
        .limit(RESUMIR_BATCH_SIZE);

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length === 0) {
        return res.json({ success: true, procesadas: 0, mensaje: 'No hay alertas pendientes de resumir' });
      }

      const {
        resultados,
        errores: erroresFichas,
        fallbackLocal,
      } = await generarFichasIAEnLote(alertas);

      let actualizadas = 0;
      const erroresUpdate = [];
      const idsActualizados = new Set();

      for (const item of resultados) {
        const { error: updError } = await supabase
          .from('alertas')
          .update({
            estado_ia: 'pendiente_revisar',
            resumen_borrador: item.ficha,
          })
          .eq('id', item.id)
          .eq('estado_ia', 'pendiente_resumir');

        if (!updError) {
          actualizadas++;
          idsActualizados.add(String(item.id));
        } else {
          console.error('Error actualizando alerta', item.id, updError.message);
          erroresUpdate.push({ id: item.id, fase: 'update', error: updError.message });
        }
      }

      const idsNoResueltos = alertas
        .filter((a) => !idsActualizados.has(String(a.id)))
        .map((a) => a.id);

      res.json({
        success: true,
        procesadas: alertas.length,
        actualizadas,
        fallback_local: fallbackLocal,
        errores: [...erroresFichas, ...erroresUpdate].slice(0, 20),
        pendientes_reintento: idsNoResueltos,
        ids: alertas.map((a) => a.id),
      });

    } catch (err) {
      console.error('Error en /alertas/resumir', err);
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/alertas/resumir', (req, res) => {
    if (!checkCronToken(req, res)) return;
    resumirHandler(req, res);
  });
  app.get('/alertas/resumir', (req, res) => {
    if (!checkCronToken(req, res)) return;
    resumirHandler(req, res);
  });

  // ══════════════════════════════════════════════════════════════
  // PASO 3 — /alertas/revisar
  // Valida la ficha compacta localmente. IA solo como rescate si se activa.
  // Cron recomendado: cada 5-10 minutos durante el horario de ingesta
  // ══════════════════════════════════════════════════════════════
  const revisarHandler = async (req, res) => {
    try {
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, url, region, fecha, contenido, resumen_borrador, provincias, sectores, subsectores, tipos_alerta')
        .eq('estado_ia', 'pendiente_revisar')
        .order('created_at', { ascending: true })
        .limit(REVISAR_BATCH_SIZE);

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length === 0) {
        return res.json({ success: true, procesadas: 0, mensaje: 'No hay borradores pendientes de revisión' });
      }

      // Revisa formato localmente; la IA queda solo como rescate opcional.
      const instructions = 'Eres un revisor experto en boletines agrarios. Corriges fichas compactas para IA. Responde SOLO con la ficha final, sin JSON, sin explicaciones.';

      let aprobadas = 0;
      let fallbackLocal = 0;
      const errores = [];

      for (const a of alertas) {
        try {
          const borrador = a.resumen_borrador ?? '';
          let revision = normalizarFichaIA(borrador, a);
          let resumenFinal = revision.texto;

          if (!revision.validaOriginal && REVISAR_IA_RESCUE) {
            const textoOriginal = a.contenido ? a.contenido.slice(0, 1800) : '';
            const prompt = `
Eres un revisor de calidad para fichas IA de alertas agrarias.

Revisa este borrador y devuelvelo corregido si es necesario. Debe mantener EXACTAMENTE estos campos:

FICHA_IA
TIPO:
PRIORIDAD:
TERRITORIO:
AFECTA_A:
HECHO:
OBJETO:
IMPACTO:
PLAZO:
ACCION:
DETALLE:
CLAVES:

Reglas:
- Maximo 1400 caracteres.
- Sin emojis, sin markdown decorativo y sin texto para WhatsApp.
- No incluyas URL.
- No inventes datos que no esten en el texto original.
- Si un dato no aparece, usa no_detectado.
- HECHO debe explicar el acto sustantivo, no copiar solo cabeceras del boletin.
- Mantiene etiquetas en mayusculas y una linea por campo.

Texto original de la alerta:
${textoOriginal}

Borrador a revisar:
${borrador}

Responde UNICAMENTE con la ficha final. Sin JSON, sin explicaciones, sin nada mas.
`.trim();

            const respuestaIA = await llamarIA(prompt, instructions, 'gpt-5-nano', { maxOutputTokens: 520 });
            revision = normalizarFichaIA(respuestaIA, a);
            resumenFinal = revision.texto;
          }

          if (!revision.validaOriginal) {
            if (!REVISAR_LOCAL_FALLBACK) {
              throw new Error('Ficha incompleta y fallback local desactivado');
            }
            fallbackLocal++;
          }

          const { error: updError } = await supabase
            .from('alertas')
            .update({
              estado_ia: 'listo',
              resumen_final: resumenFinal,
              resumen: resumenFinal, // sync para compatibilidad con whatsapp.js
            })
            .eq('id', a.id)
            .eq('estado_ia', 'pendiente_revisar');

          if (!updError) aprobadas++;
          else {
            console.error('Error aprobando alerta', a.id, updError.message);
            errores.push({ id: a.id, fase: 'update', error: updError.message });
          }

        } catch (errAlerta) {
          console.error(`[revisar] Error procesando alerta ${a.id}:`, errAlerta.message);
          errores.push({ id: a.id, fase: 'ia', error: errAlerta.message });
          if (!REVISAR_LOCAL_FALLBACK) continue;

          const resumenFallback = limpiarMensajeFinal(a.resumen_borrador, a);
          const { error: fallbackError } = await supabase
            .from('alertas')
            .update({
              estado_ia: 'listo',
              resumen_final: resumenFallback,
              resumen: resumenFallback,
            })
            .eq('id', a.id)
            .eq('estado_ia', 'pendiente_revisar');

          if (!fallbackError) {
            aprobadas++;
            fallbackLocal++;
          } else {
            console.error('Error aprobando fallback de alerta', a.id, fallbackError.message);
            errores.push({ id: a.id, fase: 'fallback_update', error: fallbackError.message });
          }
        }
      }

      res.json({
        success: true,
        procesadas: alertas.length,
        actualizadas: aprobadas,
        aprobadas,
        fallback_local: fallbackLocal,
        errores: errores.slice(0, 20),
        ids: alertas.map((a) => a.id),
      });

    } catch (err) {
      console.error('Error en /alertas/revisar', err);
      res.status(500).json({ error: err.message });
    }
  };

  app.post('/alertas/revisar', (req, res) => {
    if (!checkCronToken(req, res)) return;
    revisarHandler(req, res);
  });
  app.get('/alertas/revisar', (req, res) => {
    if (!checkCronToken(req, res)) return;
    revisarHandler(req, res);
  });

  // ══════════════════════════════════════════════════════════════
  // ENVÍO — /alertas/enviar-whatsapp
  // Solo envía alertas con estado_ia = 'listo'
  // Cron recomendado: 1 vez al día a la hora que quieras (ej: 08:00)
  // ══════════════════════════════════════════════════════════════
  const enviarWhatsAppHandler = async (req, res) => {
    try {
      const hoy = getFechaMadridISO();

      // Modo recomendado: evitar envíos por alerta individual y usar digest por usuario.
      if (DIGEST_ONLY_MODE) {
        return res.status(410).json({
          success: false,
          modo: 'digest_only',
          fecha: hoy,
          mensaje: 'Ruta desactivada para evitar spam por alerta individual. Usa /alertas/preparar-digest y /alertas/enviar-digest.',
        });
      }

      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('*')
        .eq('fecha', hoy)
        .eq('estado_ia', 'listo')
        .or('whatsapp_enviado.is.null,whatsapp_enviado.eq.false');

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length === 0) {
        return res.json({ success: true, enviadas: 0, mensaje: 'No hay alertas listas para enviar hoy', fecha: hoy });
      }

      let enviadas = 0;
      const errores = [];

      for (const alerta of alertas) {
        try {
          // Usamos resumen_final si existe, si no caemos a resumen por compatibilidad
          const alertaParaEnviar = {
            ...alerta,
            resumen: alerta.resumen_final || alerta.resumen,
          };

          await enviarWhatsAppResumen(alertaParaEnviar, supabase);
          await supabase.from('alertas').update({ whatsapp_enviado: true }).eq('id', alerta.id);
          enviadas++;
        } catch (err) {
          console.error('Error enviando WhatsApp para alerta', alerta.id, err);
          errores.push({ id: alerta.id, error: err.message });
        }
      }

      res.json({ success: true, fecha: hoy, total: alertas.length, enviadas, errores });

    } catch (err) {
      console.error('Error en /alertas/enviar-whatsapp', err);
      res.status(500).json({ error: err.message });
    }
  };

  app.get('/alertas/enviar-whatsapp', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarWhatsAppHandler(req, res);
  });
  app.post('/alertas/enviar-whatsapp', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarWhatsAppHandler(req, res);
  });

  app.get('/alertas/estado-pipeline', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();

      const { data, error } = await supabase
        .from('alertas')
        .select('id, fuente, estado_ia, resumen')
        .eq('fecha', fecha)
        .order('id', { ascending: false });

      if (error) return res.status(500).json({ error: error.message });

      const resumen = {};
      const pendientes = [];

      for (const alerta of data || []) {
        const estado = alerta.estado_ia || 'NULL';
        const tipoResumen = alerta.resumen === 'Procesando con IA...'
          ? 'procesando'
          : alerta.resumen === 'NO IMPORTA'
            ? 'no_importa'
            : alerta.resumen
              ? 'con_resumen'
              : 'sin_resumen';
        const clave = `${estado} | ${tipoResumen}`;
        resumen[clave] = (resumen[clave] || 0) + 1;

        if (
          estado === 'NULL' ||
          ['pendiente_clasificar', 'pendiente_resumir', 'pendiente_revisar'].includes(estado)
        ) {
          pendientes.push({
            id: alerta.id,
            fuente: alerta.fuente || null,
            estado_ia: alerta.estado_ia || null,
            resumen: tipoResumen,
          });
        }
      }

      return res.json({
        success: true,
        fecha,
        total: (data || []).length,
        resumen,
        pendientes_total: pendientes.length,
        pendientes_preview: pendientes.slice(0, 50),
      });
    } catch (err) {
      console.error('Error en /alertas/estado-pipeline', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post('/alertas/reparar-pendientes-ia', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();

      const { data: candidatas, error: selectError } = await supabase
        .from('alertas')
        .select('id')
        .eq('fecha', fecha)
        .eq('resumen', 'Procesando con IA...')
        .is('estado_ia', null);

      if (selectError) return res.status(500).json({ error: selectError.message });

      const ids = (candidatas || []).map((a) => a.id);
      if (ids.length === 0) {
        return res.json({
          success: true,
          fecha,
          reparadas: 0,
          mensaje: 'No hay alertas con estado_ia nulo y resumen pendiente',
        });
      }

      const { error: updateError } = await supabase
        .from('alertas')
        .update({ estado_ia: 'pendiente_clasificar' })
        .in('id', ids);

      if (updateError) return res.status(500).json({ error: updateError.message });

      return res.json({
        success: true,
        fecha,
        reparadas: ids.length,
        ids,
        siguiente_paso: 'Lanzar /alertas/clasificar, /alertas/resumir y /alertas/revisar hasta que /alertas/estado-pipeline no muestre pendientes.',
      });
    } catch (err) {
      console.error('Error en /alertas/reparar-pendientes-ia', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/alertas/reparar-pendientes-ia', (req, res) => {
    if (!checkCronToken(req, res)) return;
    return res.status(405).json({
      error: 'Usa POST para reparar. GET queda para diagnostico con /alertas/estado-pipeline.',
    });
  });

  // ══════════════════════════════════════════════════════════════
  // LEGACY — /alertas/procesar-ia (deprecada)
  // ══════════════════════════════════════════════════════════════
  app.post('/alertas/procesar-ia', (req, res) => {
    res.status(410).json({
      error: 'Ruta deprecada. Usa el pipeline: /alertas/clasificar -> /alertas/resumir -> /alertas/revisar -> /alertas/deduplicar -> /alertas/preparar-digest -> /alertas/enviar-digest',
    });
  });
  app.get('/alertas/procesar-ia', (req, res) => {
    if (!checkCronToken(req, res)) return;
    res.status(410).json({
      error: 'Ruta deprecada. Usa el pipeline: /alertas/clasificar -> /alertas/resumir -> /alertas/revisar -> /alertas/deduplicar -> /alertas/preparar-digest -> /alertas/enviar-digest',
    });
  });

};
