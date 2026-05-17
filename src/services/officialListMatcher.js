const crypto = require('crypto');
const { enviarWhatsAppDirecto } = require('../whatsapp');
const { fuentePermitida } = require('../config/planes');

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const LISTADO_NOMINAL_PATTERNS = [
  /beneficiari/,
  /personas?\s+beneficiarias?/,
  /relacion\s+(de\s+)?(beneficiarios|solicitantes|titulares|adjudicatarios)/,
  /lista(do)?\s+(de\s+)?(beneficiarios|solicitantes|titulares|adjudicatarios)/,
  /concesion\s+de\s+(ayudas|subvenciones)/,
  /subvenciones?\s+concedidas?/,
  /ayudas?\s+concedidas?/,
  /resolucion\s+de\s+concesion/,
  /pagos?\s+(de\s+)?(ayudas|subvenciones)/,
  /adjudicatari/,
  /titulares?\s+de\s+(explotaciones|derechos|ayudas)/,
];

const SOLO_CONVOCATORIA_PATTERNS = [
  /bases\s+reguladoras/,
  /convocatoria\s+de\s+ayudas/,
  /extracto\s+de\s+la\s+convocatoria/,
  /plazo\s+de\s+solicitud/,
];

function construirNombreUsuario(user) {
  const nombreLegal = [user.first_name, user.last_name_1, user.last_name_2]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  return String(user.legal_name || nombreLegal || user.name || '').trim();
}

function prepararUsuarios(users = []) {
  return users
    .map((user) => {
      const nombre = construirNombreUsuario(user);
      const nombreNormalizado = normalizar(nombre);
      const partes = nombreNormalizado.split(' ').filter(Boolean);
      if (!nombre || partes.length < 3 || nombreNormalizado.length < 10) return null;
      return {
        id: user.id,
        phone: user.phone,
        name: nombre,
        subscription: user.subscription,
        nombreNormalizado,
      };
    })
    .filter(Boolean);
}

function pareceListadoNominal(alerta) {
  const texto = normalizar([alerta.titulo, alerta.resumen, alerta.contenido].join('\n'));
  const tienePatronListado = LISTADO_NOMINAL_PATTERNS.some((pattern) => pattern.test(texto));
  if (!tienePatronListado) return false;

  const soloConvocatoria = SOLO_CONVOCATORIA_PATTERNS.some((pattern) => pattern.test(texto));
  const tieneConcesion = /concesion|concedid|beneficiari|adjudicatari|titular/.test(texto);
  return !soloConvocatoria || tieneConcesion;
}

function extraerLineaCoincidencia(texto, nombreNormalizado) {
  const lineas = String(texto || '').split(/\r?\n/);

  for (const linea of lineas) {
    const limpia = linea.replace(/\s+/g, ' ').trim();
    if (limpia.length < 8) continue;
    if (normalizar(limpia).includes(nombreNormalizado)) {
      return limpia.slice(0, 2000);
    }
  }

  const textoLimpio = String(texto || '').replace(/\s+/g, ' ').trim();
  const normalizado = normalizar(textoLimpio);
  const index = normalizado.indexOf(nombreNormalizado);
  if (index < 0) return '';

  return textoLimpio.slice(Math.max(0, index - 180), index + nombreNormalizado.length + 420).slice(0, 2000);
}

function isMissingTableError(error) {
  return error && ['42P01', '42703', 'PGRST205'].includes(error.code);
}

async function cargarUsuariosBuscables(supabase) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, subscription, phone_verified')
    .in('subscription', ['corral', 'agricultor', 'cooperativa'])
    .not('phone', 'is', null)
    .neq('phone', '')
    .or('legal_name.not.is.null,name.not.is.null')
    .or('phone_verified.is.null,phone_verified.eq.true');

  if (error) throw error;
  return prepararUsuarios(data || []);
}

async function guardarYEnviarCoincidencia(supabase, { alerta, user, linea, enviar }) {
  const contexto = alerta.fecha || '';
  const fuente = alerta.fuente || 'BOLETIN';
  const lineHash = crypto
    .createHash('sha256')
    .update(`${fuente}|${alerta.id}|${user.id}|${linea}`)
    .digest('hex');

  const row = {
    user_id: user.id,
    alerta_id: alerta.id,
    fuente,
    contexto,
    listado_titulo: alerta.titulo || null,
    persona_detectada: user.name,
    archivo: null,
    linea,
    line_hash: lineHash,
    url_fuente: alerta.url,
    enviado: false,
    metadata: {
      region: alerta.region || null,
      fecha: alerta.fecha || null,
      detector: 'alertas_contenido',
    },
  };

  const { data, error } = await supabase
    .from('official_list_matches')
    .upsert([row], { onConflict: 'user_id,fuente,contexto,persona_detectada,line_hash' })
    .select('id, enviado')
    .single();

  if (error && isMissingTableError(error)) {
    return { saved: false, missingTable: true, alreadySent: false, sent: false };
  }
  if (error) throw error;

  if (!enviar || data?.enviado) {
    return { saved: true, id: data?.id, alreadySent: Boolean(data?.enviado), sent: false };
  }

  const mensaje = [
    `*Ruralicos - aviso ${fuente}*`,
    '',
    'Hemos encontrado tu nombre en un listado oficial que puede afectar a ayudas, beneficiarios o resoluciones.',
    '',
    `Nombre detectado: ${user.name}`,
    `Listado: ${alerta.titulo}`,
    `Fuente: ${alerta.url}`,
    '',
    'Revisalo con calma en la web oficial. Si quieres, responde a este WhatsApp y te ayudamos a interpretarlo.',
  ].join('\n');

  await enviarWhatsAppDirecto(user.phone, mensaje, 'official_list_match');

  const { error: errUpdate } = await supabase
    .from('official_list_matches')
    .update({ enviado: true, enviado_at: new Date().toISOString() })
    .eq('id', data.id);

  if (errUpdate) console.warn('[official-list-match] No se pudo marcar como enviada:', errUpdate.message);

  return { saved: true, id: data?.id, alreadySent: false, sent: true };
}

async function cotejarListadosOficiales(supabase, opciones = {}) {
  const {
    fecha = null,
    enviar = false,
    limit = 500,
    fuente = null,
  } = opciones;

  let query = supabase
    .from('alertas')
    .select('id, titulo, resumen, url, fecha, region, fuente, contenido')
    .not('contenido', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (fecha) query = query.eq('fecha', fecha);
  if (fuente) query = query.eq('fuente', fuente);

  const { data: alertas, error } = await query;
  if (error) throw error;

  const candidatas = (alertas || []).filter(pareceListadoNominal);
  const usuarios = await cargarUsuariosBuscables(supabase);

  let coincidencias = 0;
  let guardadas = 0;
  let enviados = 0;
  let yaEnviados = 0;
  let missingTable = false;
  const resultados = [];

  for (const alerta of candidatas) {
    const texto = [alerta.titulo, alerta.resumen, alerta.contenido].join('\n');
    const textoNormalizado = normalizar(texto);
    const fuenteAlerta = alerta.fuente || 'BOE';
    const usuariosPermitidos = usuarios.filter((user) => fuentePermitida(user.subscription, fuenteAlerta));

    for (const user of usuariosPermitidos) {
      if (!textoNormalizado.includes(user.nombreNormalizado)) continue;

      const linea = extraerLineaCoincidencia(texto, user.nombreNormalizado);
      if (!linea) continue;

      coincidencias++;
      const resultado = await guardarYEnviarCoincidencia(supabase, { alerta, user, linea, enviar });
      if (resultado.missingTable) missingTable = true;
      if (resultado.saved) guardadas++;
      if (resultado.sent) enviados++;
      if (resultado.alreadySent) yaEnviados++;
      resultados.push({
        alerta_id: alerta.id,
        fuente: alerta.fuente,
        user_id: user.id,
        user_name: user.name,
        ...resultado,
      });
    }
  }

  return {
    success: true,
    fecha,
    fuente,
    alertas_revisadas: (alertas || []).length,
    candidatas: candidatas.length,
    usuarios_revisados: usuarios.length,
    coincidencias,
    guardadas,
    enviados,
    ya_enviados: yaEnviados,
    missing_table: missingTable ? 'Ejecuta docs/official_list_matches_schema.sql' : false,
    resultados,
  };
}

module.exports = {
  cotejarListadosOficiales,
  pareceListadoNominal,
  normalizar,
};
