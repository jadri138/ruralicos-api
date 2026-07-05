const { checkCronToken } = require('../../../../middleware/cronToken');
const crypto = require('crypto');
const { enviarWhatsAppDirecto } = require('../../../../platform/whatsapp');
const { fuentePermitida } = require('../../../../config/planes');
const { conOrganizationId, extraerOrganizationId } = require('../../../mia/organizationContext');
const {
  BENEFICIARIOS_URL,
  obtenerFicheroBeneficiarios,
  obtenerTextosBeneficiariosConCache,
  obtenerFirmaRemota,
  firmaUsuarios,
  buscarCoincidenciasEnTextos,
} = require('../../scrapers/estatales/fega/scraper');
const cache = require('../../scrapers/estatales/fega/fegaCache');
const {
  CAPTURE_STATUS,
  registrarRawDocuments,
  marcarRawDocumentInsertado,
  marcarRawDocumentSaltado,
} = require('../../rawDocuments/rawDocuments.service');

async function insertarAlertaFega(supabase, fichero) {
  const titulo = `FEGA - Beneficiarios ayudas PAC ${fichero.ejercicio}`;
  const hoy = new Date().toISOString().slice(0, 10);

  // Captura bruta: la publicacion FEGA detectada queda registrada en raw_documents
  // ANTES de comprobar duplicados o insertar la alerta (no se pierde).
  const [raw] = await registrarRawDocuments(supabase, [{
    titulo,
    url: fichero.paginaDetalle,
    url_pdf: fichero.urlDescarga,
    fecha: hoy,
    organismo: 'FEGA',
    boletin: String(fichero.ejercicio),
    metadata_json: { ejercicio: fichero.ejercicio, urlDescarga: fichero.urlDescarga },
  }], { fuente: 'FEGA', region: 'España' });
  const rawId = raw?.raw_document_id || null;
  console.log(`[FEGA] raw_document ${rawId ? `registrado id=${rawId}` : 'NO registrado (revisar raw_documents)'} ejercicio=${fichero.ejercicio} url=${fichero.paginaDetalle}`);

  const { data: existente, error: errExiste } = await supabase
    .from('alertas')
    .select('id')
    .eq('url', fichero.paginaDetalle)
    .limit(1);

  if (errExiste) throw errExiste;
  if (existente && existente.length > 0) {
    await marcarRawDocumentSaltado(supabase, rawId, 'duplicate_url', {
      status: CAPTURE_STATUS.DUPLICATE,
    });
    console.log(`[FEGA] alerta ya existente (id=${existente[0].id}) -> raw_document ${rawId} marcado duplicate (conserva inserted si ya originó alerta)`);
    return { inserted: false, id: existente[0].id };
  }

  const { data, error } = await supabase
    .from('alertas')
    .insert([{
      titulo,
      resumen: 'Procesando con IA...',
      estado_ia: 'pendiente_clasificar',
      url: fichero.paginaDetalle,
      fecha: hoy,
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
  const alertaId = data?.id || null;
  await marcarRawDocumentInsertado(supabase, rawId, alertaId);
  console.log(`[FEGA] alerta nueva creada (id=${alertaId}) -> raw_document ${rawId} marcado inserted`);
  return { inserted: true, id: alertaId };
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

      // Gate de menor coste: si ni el fichero (firma HEAD) ni el conjunto de
      // usuarios han cambiado desde la ultima deteccion, el resultado seria
      // identico -> omitimos descarga, extraccion y cruce.
      const firma = await obtenerFirmaRemota(fichero.urlDescarga);
      const usersHash = firmaUsuarios(users);
      const metaPrevia = cache.leerMeta(fichero.ejercicio);
      const sinCambios = !forzar
        && firma?.etag
        && metaPrevia?.etag === firma.etag
        && metaPrevia?.usersHash === usersHash
        && cache.datosExisten(fichero.ejercicio);

      if (sinCambios) {
        return res.json({
          success: true,
          ejercicio: fichero.ejercicio,
          fichero,
          alerta,
          fichero_actualizado: false,
          desde_cache: true,
          deteccion: 'omitida_sin_cambios',
          usuarios_revisados: users.length,
          coincidencias: metaPrevia.ultimasCoincidencias ?? null,
          mensaje: 'Sin cambios en fichero FEGA ni en usuarios; deteccion omitida.',
        });
      }

      const { textos, actualizado, desdeCache } = await obtenerTextosBeneficiariosConCache(fichero, { forzar, firma });
      const matches = buscarCoincidenciasEnTextos(textos, users);

      const resultados = [];
      let enviados = 0;
      let yaEnviados = 0;

      for (const match of matches) {
        const resultado = await guardarCoincidencia(supabase, {
          ejercicio: fichero.ejercicio,
          fichero,
          match,
          enviar,
        });
        if (resultado.sent) enviados++;
        if (resultado.alreadySent) yaEnviados++;
        resultados.push({ user_id: match.user_id, user_name: match.user_name, ...resultado });
      }

      // Registramos la huella de esta deteccion para poder omitir las proximas
      // ejecuciones si nada cambia.
      cache.actualizarMeta(fichero.ejercicio, {
        usersHash,
        ultimasCoincidencias: matches.length,
        ultimaDeteccionAt: new Date().toISOString(),
      });

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
        resultados,
      });
    } catch (err) {
      console.error('Error en /scrape-fega-beneficiarios', err);
      return res.status(500).json({ error: err.message });
    }
  });
};

module.exports.insertarAlertaFega = insertarAlertaFega;
