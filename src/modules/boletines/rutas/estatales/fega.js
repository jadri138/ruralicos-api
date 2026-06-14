const { checkCronToken } = require('../../../../middleware/cronToken');
const crypto = require('crypto');
const { enviarWhatsAppDirecto } = require('../../../../platform/whatsapp');
const { fuentePermitida } = require('../../../../config/planes');
const { conOrganizationId, extraerOrganizationId } = require('../../../mia/organizationContext');
const {
  BENEFICIARIOS_URL,
  obtenerFicheroBeneficiarios,
  obtenerTextosBeneficiariosConCache,
  buscarCoincidenciasEnTextos,
} = require('../../scrapers/estatales/fega/scraper');

function isMissingTableError(error) {
  return error && ['42P01', '42703', 'PGRST205'].includes(error.code);
}

async function insertarAlertaFega(supabase, fichero) {
  const titulo = `FEGA - Beneficiarios ayudas PAC ${fichero.ejercicio}`;

  const { data: existente, error: errExiste } = await supabase
    .from('alertas')
    .select('id')
    .eq('url', fichero.paginaDetalle)
    .limit(1);

  if (errExiste) throw errExiste;
  if (existente && existente.length > 0) return { inserted: false, id: existente[0].id };

  const { data, error } = await supabase
    .from('alertas')
    .insert([{
      titulo,
      resumen: 'Procesando con IA...',
      estado_ia: 'pendiente_clasificar',
      url: fichero.paginaDetalle,
      fecha: new Date().toISOString().slice(0, 10),
      region: 'España',
      fuente: 'FEGA',
      contenido: [
        `Publicacion oficial FEGA de beneficiarios de ayudas PAC ${fichero.ejercicio}.`,
        `Pagina de consulta: ${BENEFICIARIOS_URL}`,
        `Descarga: ${fichero.urlDescarga}`,
        'Incluye datos de beneficiarios FEAGA/FEADER publicados por transparencia.',
      ].join('\n'),
    }])
    .select('id')
    .single();

  if (error) throw error;
  return { inserted: true, id: data?.id || null };
}

async function usuariosBuscables(supabase) {
  const { data, error } = await supabase
    .from('users')
    .select('id, name, first_name, last_name_1, last_name_2, legal_name, phone, subscription, organization_id, phone_verified')
    .in('subscription', ['corral', 'agricultor', 'cooperativa'])
    .not('phone', 'is', null)
    .neq('phone', '')
    .or('legal_name.not.is.null,name.not.is.null')
    .or('phone_verified.is.null,phone_verified.eq.true');

  if (error) throw error;
  return (data || []).filter((user) => fuentePermitida(user.subscription, 'FEGA'));
}

async function guardarCoincidencia(supabase, { ejercicio, fichero, match, enviar }) {
  const lineHash = crypto
    .createHash('sha256')
    .update(`FEGA|${ejercicio}|${match.archivo}|${match.linea}`)
    .digest('hex');

  const row = conOrganizationId({
    user_id: match.user_id,
    fuente: 'FEGA',
    contexto: String(ejercicio),
    listado_titulo: `Beneficiarios ayudas PAC ${ejercicio}`,
    persona_detectada: match.beneficiario,
    archivo: match.archivo,
    linea: match.linea,
    line_hash: lineHash,
    url_fuente: fichero.paginaDetalle,
    enviado: false,
    metadata: {
      ejercicio,
      tipo_listado: 'beneficiarios_pac',
      descarga: fichero.urlDescarga,
    },
  }, extraerOrganizationId(match));

  const { data, error } = await supabase
    .from('official_list_matches')
    .upsert([row], { onConflict: 'user_id,fuente,contexto,persona_detectada,line_hash' })
    .select('id, enviado')
    .single();

  if (error && isMissingTableError(error)) {
    return { saved: false, missingTable: true, alreadySent: false };
  }
  if (error) throw error;

  if (!enviar || data?.enviado) {
    return { saved: true, id: data?.id, alreadySent: Boolean(data?.enviado), sent: false };
  }

  const mensaje = [
    '*Ruralicos - aviso FEGA*',
    '',
    `Hemos encontrado tu nombre en el listado oficial FEGA de beneficiarios de ayudas PAC ${ejercicio}.`,
    '',
    `Nombre detectado: ${match.beneficiario}`,
    `Fuente: ${fichero.paginaDetalle}`,
    '',
    'Revísalo con calma en la web oficial. Si quieres, responde a este WhatsApp y te ayudamos a interpretarlo.',
  ].join('\n');

  await enviarWhatsAppDirecto(match.phone, mensaje, 'fega_match');

  const { error: errUpdate } = await supabase
    .from('official_list_matches')
    .update({ enviado: true, enviado_at: new Date().toISOString() })
    .eq('id', data.id);

  if (errUpdate) console.warn('[FEGA] No se pudo marcar coincidencia como enviada:', errUpdate.message);

  return { saved: true, id: data?.id, alreadySent: false, sent: true };
}

module.exports = function fegaRoutes(app, supabase) {
  app.get('/scrape-fega-beneficiarios', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    const ejercicio = req.query.ejercicio ? Number(req.query.ejercicio) : null;
    const enviar = String(req.query.enviar || 'false').toLowerCase() === 'true';
    const soloDetectar = String(req.query.detectar || 'true').toLowerCase() !== 'false';

    try {
      const fichero = await obtenerFicheroBeneficiarios(ejercicio);
      const alerta = await insertarAlertaFega(supabase, fichero);

      if (!soloDetectar) {
        return res.json({
          success: true,
          ejercicio: fichero.ejercicio,
          fichero,
          alerta,
          deteccion: 'omitida',
        });
      }

      const users = await usuariosBuscables(supabase);
      if (users.length === 0) {
        return res.json({
          success: true,
          ejercicio: fichero.ejercicio,
          fichero,
          alerta,
          usuarios_revisados: 0,
          archivos_revisados: [],
          coincidencias: 0,
          enviados: 0,
          ya_enviados: 0,
          missing_table: false,
          resultados: [],
          mensaje: 'Sin usuarios con plan permitido para FEGA.',
        });
      }

      const forzar = String(req.query.forzar_descarga || 'false').toLowerCase() === 'true';
      const { textos, actualizado, desdeCache } = await obtenerTextosBeneficiariosConCache(fichero, { forzar });
      const matches = buscarCoincidenciasEnTextos(textos, users);

      const resultados = [];
      let missingTable = false;
      let enviados = 0;
      let yaEnviados = 0;

      for (const match of matches) {
        const resultado = await guardarCoincidencia(supabase, {
          ejercicio: fichero.ejercicio,
          fichero,
          match,
          enviar,
        });
        if (resultado.missingTable) missingTable = true;
        if (resultado.sent) enviados++;
        if (resultado.alreadySent) yaEnviados++;
        resultados.push({ user_id: match.user_id, user_name: match.user_name, ...resultado });
      }

      return res.json({
        success: true,
        ejercicio: fichero.ejercicio,
        fichero,
        alerta,
        fichero_actualizado: actualizado,
        desde_cache: desdeCache,
        usuarios_revisados: users.length,
        archivos_revisados: textos.map((t) => t.fileName),
        coincidencias: matches.length,
        enviados,
        ya_enviados: yaEnviados,
        missing_table: missingTable ? 'Falta la tabla official_list_matches. Aplica la migracion operativa para guardar y evitar duplicados.' : false,
        resultados,
      });
    } catch (err) {
      console.error('Error en /scrape-fega-beneficiarios', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
