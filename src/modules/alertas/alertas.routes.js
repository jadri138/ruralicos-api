// src/modules/alertas/alertas.routes.js
//
// Capa HTTP de alertas: registra los endpoints del pipeline
// (/alertas, /alertas/clasificar, /alertas/resumir, /alertas/revisar,
// /alertas/estado-pipeline, /alertas/procesar-ia...). La logica vive en
// alertas.service.js.
const { checkCronToken, hasCronToken } = require('../../middleware/cronToken');
const { llamarIA, parsearJSON } = require('../../platform/ia/llamarIA');
const { enviarWhatsAppResumen } = require('../../platform/whatsapp');
const { getFechaMadridISO } = require('../../shared/fechaMadrid');
const { requireAdmin } = require('../../middleware/requireAdmin');

const {
  DIGEST_ONLY_MODE,
  CLASIFICAR_BATCH_SIZE,
  RESUMIR_BATCH_SIZE,
  REVISAR_BATCH_SIZE,
  CLASIFICAR_LOCAL_FALLBACK,
  RESUMIR_LOCAL_FALLBACK,
  REVISAR_LOCAL_FALLBACK,
  REVISAR_IA_RESCUE,
  CLASIFICACION_TEXT_FORMAT,
  FICHA_IA_TEXT_FORMAT,
  requireAdminOrCron,
  validarFechaISO,
  leerLimiteAlertas,
  normalizarTexto,
  contieneAlguno,
  textoAlertaNormalizado,
  esProcesoAdministrativoPersonal,
  esPescaOMaritimoNoAgrario,
  esAdministracionGeneralNoAgraria,
  detectarExclusionDuraAlerta,
  clasificacionDescartada,
  limpiarArrayStrings,
  limpiarArrayEnum,
  leerBooleano,
  extraerResultadosClasificacion,
  clasificarLocalmente,
  normalizarResultadoClasificacion,
  limpiarTextoMensaje,
  lineaBoletinPocoUtil,
  limpiarContenidoBoletinParaIA,
  extraerExtractoBoletin,
  campoFichaGenerico,
  construirMensajeFallback,
  limpiarMensajeFinal,
  FICHA_CAMPOS_REQUERIDOS,
  FICHA_TIPOS,
  FICHA_PRIORIDADES,
  limpiarCampoFicha,
  limitarPalabras,
  primerArray,
  normalizarTipoFicha,
  normalizarPrioridadFicha,
  normalizarClavesFicha,
  construirResumenDigestFicha,
  construirFichaIA,
  parsearFichaIA,
  normalizarFichaIA,
  extraerResultadosFichaIA,
  normalizarResultadoFichaIA,
  buildPromptFichasIA,
  generarFichasIAEnLote,
  buildPromptClasificar,
  clasificarConReintento,
} = require('./alertas.service');

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

      const alertasDescartadasPrefiltro = alertas
        .map((alerta) => ({ alerta, motivo: detectarExclusionDuraAlerta(alerta) }))
        .filter((item) => item.motivo);
      const idsDescartadosPrefiltro = new Set(alertasDescartadasPrefiltro.map((item) => String(item.alerta.id)));
      const alertasParaResumir = alertas.filter((alerta) => !idsDescartadosPrefiltro.has(String(alerta.id)));

      const {
        resultados,
        errores: erroresFichas,
        fallbackLocal,
      } = alertasParaResumir.length > 0
        ? await generarFichasIAEnLote(alertasParaResumir)
        : { resultados: [], errores: [], fallbackLocal: 0 };

      let actualizadas = 0;
      let descartadas = 0;
      const erroresUpdate = [];
      const idsActualizados = new Set();

      for (const { alerta, motivo } of alertasDescartadasPrefiltro) {
        const { error: updError } = await supabase
          .from('alertas')
          .update({
            estado_ia: 'descartado',
            resumen: `NO IMPORTA: ${motivo}`,
            resumen_borrador: null,
            provincias: [],
            sectores: [],
            subsectores: [],
            tipos_alerta: [],
          })
          .eq('id', alerta.id)
          .eq('estado_ia', 'pendiente_resumir');

        if (!updError) {
          descartadas++;
          actualizadas++;
          idsActualizados.add(String(alerta.id));
        } else {
          erroresUpdate.push({ id: alerta.id, fase: 'prefiltro', error: updError.message });
        }
      }

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
        descartadas_prefiltro: descartadas,
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
      let descartadas = 0;
      let fallbackLocal = 0;
      const errores = [];

      for (const a of alertas) {
        try {
          const borrador = a.resumen_borrador ?? '';
          const exclusion = detectarExclusionDuraAlerta({ ...a, resumen_borrador: borrador });
          if (exclusion) {
            const { error: updError } = await supabase
              .from('alertas')
              .update({
                estado_ia: 'descartado',
                resumen: `NO IMPORTA: ${exclusion}`,
                resumen_final: null,
                provincias: [],
                sectores: [],
                subsectores: [],
                tipos_alerta: [],
              })
              .eq('id', a.id)
              .eq('estado_ia', 'pendiente_revisar');

            if (!updError) {
              descartadas++;
              continue;
            }
            errores.push({ id: a.id, fase: 'prefiltro', error: updError.message });
          }

          let revision = normalizarFichaIA(borrador, a);
          let resumenFinal = revision.texto;

          if (!revision.validaOriginal && REVISAR_IA_RESCUE) {
            const textoOriginal = limpiarContenidoBoletinParaIA(a, 1800);
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
RESUMEN_DIGEST:
CLAVES:

Reglas:
- Maximo 2200 caracteres.
- Sin emojis, sin markdown decorativo y sin texto para WhatsApp.
- No incluyas URL.
- No inventes datos que no esten en el texto original.
- Si un dato no aparece, usa no_detectado.
- HECHO debe explicar que publica el boletin, no copiar solo cabeceras del boletin.
- DETALLE debe contener un dato concreto del texto original si existe: expediente, municipio, ayuda, requisito, periodo, beneficiario, especie, cultivo, importe o tramite.
- RESUMEN_DIGEST debe ser 2-4 frases cortas con contexto suficiente para el digest: que significa en lenguaje normal, a quien afecta, territorio, tramite/plazo y dato concreto si aparece.
- RESUMEN_DIGEST debe sonar a humano: "Es una ayuda...", "Cambia una norma...", "Abre un plazo...", "Publican un listado...". Evita empezar con "El boletin publica" si puedes decirlo mas claro.
- Prohibido dejar frases genericas como "publicacion oficial relevante", "revisa si aplica", "revisar documento oficial" o "determinar su aplicabilidad".
- Si no se puede extraer el acto publicado, usa prioridad=baja, hecho=no_detectado, impacto=no_detectado, accion=no_enviar_digest, detalle=no_detectado y resumen_digest=no_detectado.
- Mantiene etiquetas en mayusculas y una linea por campo.

Texto original de la alerta:
${textoOriginal}

Borrador a revisar:
${borrador}

Responde UNICAMENTE con la ficha final. Sin JSON, sin explicaciones, sin nada mas.
`.trim();

            const respuestaIA = await llamarIA(prompt, instructions, 'gpt-5-nano', { maxOutputTokens: 820 });
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
        actualizadas: aprobadas + descartadas,
        aprobadas,
        descartadas_prefiltro: descartadas,
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

