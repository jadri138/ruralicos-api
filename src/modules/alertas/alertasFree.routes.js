// src/routes/alertasFree.js

const { checkCronToken } = require('../../middleware/cronToken');
const { llamarIA, parsearJSON } = require('../../platform/ia/llamarIA');
const { enviarWhatsAppFree } = require('../../platform/whatsapp');
const { getFechaMadridISO } = require('../../shared/fechaMadrid');
const {
  diagnosticarTaxonomiaDerivadaAlerta,
} = require('./seleccion/alertaMatcher');
const {
  sectoresDerivadosAlerta,
} = require('../../shared/sectorTaxonomy');

const FREE_MAX_ITEMS = 8;
const FREE_HEADER = '*RURALICOS INFORMA* · Resumen de boletines oficiales de hoy (agricultura y ganadería)';
const FREE_FOOTER = '*Alertas más extensas y personalizadas en la versión PRO.*';

function normalizarTextoFree(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function textoCandidatoFree(alerta = {}) {
  return normalizarTextoFree([
    alerta.titulo,
    alerta.resumen,
    alerta.resumen_final,
    alerta.contenido,
  ].filter(Boolean).join(' '));
}

function fuenteResumenFree(alerta = {}) {
  const source = String(alerta.fuente || '').replace(/[^A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ ._-]/g, '').trim();
  return source ? source.toUpperCase().slice(0, 32) : 'FUENTE OFICIAL';
}

function evaluarCandidataResumenFree(alerta = {}) {
  if (alerta?.estado_ia !== 'listo') {
    return { elegible: false, score: 0, motivo: 'estado_no_listo' };
  }
  if (!alertaTieneTaxonomiaMinima(alerta)) {
    return { elegible: false, score: 0, motivo: 'taxonomia_incompleta' };
  }

  const sectores = sectoresDerivadosAlerta(alerta);
  if (!sectores.some((sector) => ['agricultura', 'ganaderia', 'mixto'].includes(sector))) {
    return { elegible: false, score: 0, motivo: 'fuera_sector_rural_free' };
  }

  const texto = textoCandidatoFree(alerta);
  if (!texto) return { elegible: false, score: 0, motivo: 'sin_texto' };
  if (/\b(?:sin impacto directo|sin relevancia|no afecta al sector|no resulta relevante)\b/.test(texto)) {
    return { elegible: false, score: 0, motivo: 'sin_impacto_directo' };
  }

  const signals = [];
  let score = 0;
  const sumar = (nombre, puntos, pattern) => {
    if (!pattern.test(texto)) return;
    score += puntos;
    signals.push(nombre);
  };

  sumar('ayudas', 6, /\b(?:ayudas?|subvenciones?|beneficiari\w*|pac|fega|feader|indemnizaciones?)\b/);
  sumar('convocatoria', 2, /\bconvocatori\w*\b/);
  sumar('plazo_accion', 5, /\b(?:plazos?|solicitudes?|solicitar|alegaciones?|inscripcion\w*|declaracion\w*|tramites?|presentacion)\b/);
  sumar('sanidad', 5, /\b(?:sanidad (?:animal|vegetal)|zoosanit\w*|fitosanit\w*|epizooti\w*|plagas?|enfermedad(?:es)? animal(?:es)?|vacunacion)\b/);
  sumar('obligacion_emergencia', 5, /\b(?:obligaciones?|prohibiciones?|restricciones?|emergencia|incendios?|bioseguridad|inmovilizacion|sacrificio)\b/);
  sumar('agua_regadio', 4, /\b(?:regadios?|riegos?|regantes|infraestructura hidraulica|concesion de aguas?)\b/);
  sumar('norma_sectorial', 3, /\b(?:real decreto|orden|resolucion|normativa|reglamento)\b/);
  sumar('actividad_rural', 2, /\b(?:explotaciones? agrari\w*|agricultor\w*|ganader\w*|cultivos?|cosechas?|bovin\w*|ovin\w*|caprin\w*|porcin\w*|avic\w*|jabali\w*)\b/);

  const ruidoAdministrativo = /\b(?:nombramientos?|ceses?|plantilla de personal|relacion de puestos|oferta de empleo|bolsa de empleo|cuenta general|presupuesto general|aprobacion del presupuesto|licitacion\w*|adjudicacion\w*|contratacion\w*|urbanismo|licencia de obras?)\b/.test(texto);
  const senalFuerte = signals.some((signal) =>
    ['ayudas', 'plazo_accion', 'sanidad', 'obligacion_emergencia', 'agua_regadio'].includes(signal)
  );
  const senalFuerteSectorial = signals.some((signal) =>
    ['ayudas', 'sanidad', 'obligacion_emergencia', 'agua_regadio'].includes(signal)
  );
  if (ruidoAdministrativo && !senalFuerteSectorial) {
    return { elegible: false, score, motivo: 'ruido_administrativo', signals };
  }

  return {
    elegible: senalFuerte && score >= 6,
    score,
    motivo: senalFuerte && score >= 6 ? 'impacto_rural_accionable' : 'impacto_insuficiente',
    signals,
  };
}

function seleccionarAlertasResumenFree(alertas = [], { maxItems = FREE_MAX_ITEMS } = {}) {
  const candidatas = (Array.isArray(alertas) ? alertas : [])
    .map((alerta) => ({ alerta, evaluacion: evaluarCandidataResumenFree(alerta) }))
    .filter(({ evaluacion }) => evaluacion.elegible)
    .sort((a, b) =>
      b.evaluacion.score - a.evaluacion.score ||
      String(a.alerta.id).localeCompare(String(b.alerta.id))
    );

  const seleccionadas = [];
  const urls = new Set();
  const porFuente = new Map();
  const limite = Math.max(1, Math.min(FREE_MAX_ITEMS, Number(maxItems) || FREE_MAX_ITEMS));

  function incluir(item, aplicarCupo) {
    const url = String(item.alerta.url || '').trim();
    if (!/^https?:\/\//i.test(url) || urls.has(url)) return false;
    const fuente = fuenteResumenFree(item.alerta);
    const count = porFuente.get(fuente) || 0;
    if (aplicarCupo && count >= 3) return false;
    urls.add(url);
    porFuente.set(fuente, count + 1);
    seleccionadas.push({ ...item.alerta, free_score: item.evaluacion.score });
    return true;
  }

  for (const item of candidatas) {
    if (seleccionadas.length >= limite) break;
    incluir(item, true);
  }
  for (const item of candidatas) {
    if (seleccionadas.length >= limite) break;
    incluir(item, false);
  }
  return seleccionadas;
}

function miniResumenFree(alerta = {}) {
  const resumen = String(alerta.resumen || alerta.titulo || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const primeraFrase = resumen.split(/(?<=[.!?])\s+/)[0] || resumen;
  const recortado = primeraFrase.length > 260
    ? `${primeraFrase.slice(0, 257).trimEnd()}...`
    : primeraFrase;
  return recortado.replace(/^[*\d). -]+/, '').trim();
}

function construirResumenFreeLocal(alertas = []) {
  const seleccionadas = (Array.isArray(alertas) ? alertas : []).slice(0, FREE_MAX_ITEMS);
  const lineas = seleccionadas.map((alerta, index) =>
    `*${index + 1})* ${miniResumenFree(alerta)} → ${fuenteResumenFree(alerta)}: ${alerta.url}`
  );
  return [
    FREE_HEADER,
    '',
    `Hoy destacamos ${seleccionadas.length} aviso${seleccionadas.length === 1 ? '' : 's'} con impacto práctico en el campo.`,
    '',
    ...lineas,
    '',
    FREE_FOOTER,
  ].join('\n').trim();
}

function validarResumenFreeIA(mensaje, alertas = []) {
  if (typeof mensaje !== 'string') return { ok: false, motivo: 'mensaje_ausente' };
  const limpio = mensaje.trim();
  if (!limpio.startsWith(FREE_HEADER)) return { ok: false, motivo: 'cabecera_invalida' };
  if (!limpio.endsWith(FREE_FOOTER)) return { ok: false, motivo: 'pie_invalido' };

  const permitidas = new Set(alertas.map((alerta) => String(alerta.url || '').trim()).filter(Boolean));
  const urls = limpio.match(/https?:\/\/[^\s<>)\]}]+/gi) || [];
  const urlsLimpias = urls.map((url) => url.replace(/[.,;:!?]+$/, ''));
  if (urlsLimpias.length === 0 || urlsLimpias.some((url) => !permitidas.has(url))) {
    return { ok: false, motivo: 'url_no_autorizada' };
  }
  for (const url of urlsLimpias) {
    const alerta = alertas.find((item) => String(item.url || '').trim() === url);
    if (!alerta || !limpio.includes(`${fuenteResumenFree(alerta)}: ${url}`)) {
      return { ok: false, motivo: 'fuente_incorrecta' };
    }
  }
  const items = (limpio.match(/^\*\d+\)\*/gm) || []).length;
  if (items < 1 || items > Math.min(FREE_MAX_ITEMS, alertas.length) || items !== urlsLimpias.length) {
    return { ok: false, motivo: 'numero_items_invalido' };
  }
  return { ok: true, items };
}

function alertaTieneTaxonomiaMinima(alerta = {}) {
  return diagnosticarTaxonomiaDerivadaAlerta(alerta) === null;
}

function buscarAlertaConResumenFreeValido(alertas = []) {
  const lista = Array.isArray(alertas)
    ? alertas.filter((alerta) => alerta?.estado_ia === 'listo')
    : [];
  const resumenes = [...new Set(lista.map((alerta) => alerta.resumenfree).filter(Boolean))];

  for (const resumen of resumenes) {
    const vinculadas = lista.filter((alerta) => alerta.resumenfree === resumen);
    if (vinculadas.length === 0) continue;
    if (vinculadas.some((alerta) => !evaluarCandidataResumenFree(alerta).elegible)) continue;
    if (!validarResumenFreeIA(resumen, vinculadas).ok) continue;
    return vinculadas[0];
  }
  return null;
}

module.exports = function alertasFreeRoutes(app, supabase) {
  // ================================================
  // 1) Generar resumen FREE general a partir de resúmenes PRO
  // ================================================
  const generarResumenFreeHandler = async (req, res) => {
    try {
      const hoy = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();

      // Alertas de HOY ya procesadas por la IA PRO (resumen listo y relevante)
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, resumen, resumen_final, url, fuente, fecha, estado_ia, sectores, subsectores, tipos_alerta, taxonomy_tags')
        .eq('fecha', hoy)
        .eq('estado_ia', 'listo')
        .neq('resumen', 'Procesando con IA...')
        .not('resumen', 'is', null);

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const alertasClasificadas = (alertas || []).filter(alertaTieneTaxonomiaMinima);
      const alertasSeleccionadas = seleccionarAlertasResumenFree(alertasClasificadas);

      if (alertasSeleccionadas.length === 0) {
        return res.json({
          success: true,
          procesadas: 0,
          candidatas_clasificadas: alertasClasificadas.length,
          descartadas_por_interes: alertasClasificadas.length,
          mensaje: 'No hay alertas rurales con impacto práctico suficiente para el resumen FREE de hoy',
          fecha: hoy,
        });
      }

      // La IA solo ve la selección acotada y trazable; nunca recibe las decenas
      // de anuncios administrativos que ya descartó el filtro determinista.
      const lista = alertasSeleccionadas
        .map((a) => {
          const corto = (a.resumen || '').slice(0, 400);
          return `ID ${a.id} | Fuente: ${fuenteResumenFree(a)} | Titulo: ${a.titulo} | ResumenPro: ${corto} | Url: ${a.url}`;
        })
        .join('\n');

      const prompt = `
Te paso una lista cerrada de alertas de boletines oficiales ya analizadas para usuarios PRO.

Cada línea tiene:
ID <id> | Fuente: <fuente> | Titulo: <titulo> | ResumenPro: <resumen corto> | Url: <url>

TU TAREA:
Genera UN ÚNICO mensaje de WhatsApp para usuarios GRATUITOS de Ruralicos (versión FREE).

Formato EXACTO:

${FREE_HEADER}

1 frase introductoria.

Luego, una lista numerada:
*1)* mini resumen muy claro (basado en ResumenPro) → <FUENTE>: <url>
*2)* ...
*3)* ...

- NO inventes información.
- Usa exclusivamente las URLs y fuentes recibidas.
- NO pongas emojis.
- Usa frases cortas y muy sencillas para agricultores y ganaderos.
- Incluye entre 1 y ${alertasSeleccionadas.length} alertas. No añadas ninguna que no esté en la lista.
- Termina SIEMPRE con esta frase literal:
${FREE_FOOTER}

FORMATO DE SALIDA OBLIGATORIO:
Devuelve SOLO este JSON válido:

{
  "mensaje": "<mensaje final>"
}

Nada de texto fuera del JSON.

Lista de alertas:
${lista}
      `.trim();

      const instructions = 'Eres un asistente experto en resumir información compleja en mensajes de WhatsApp muy claros. Responde SIEMPRE solo con el JSON pedido.';

      let contenido;
      let resumenfree = '';
      let generador = 'ia_validada';
      let fallbackMotivo = null;
      try {
        contenido = await llamarIA(prompt, instructions, 'gpt-4o-mini', { task: 'resumen_free' });
      } catch (e) {
        console.error('Error IA FREE:', e.message);
        fallbackMotivo = 'error_ia';
      }

      if (contenido) {
        try {
          const parsed = parsearJSON(contenido);
          const validacion = validarResumenFreeIA(parsed?.mensaje, alertasSeleccionadas);
          if (validacion.ok) {
            resumenfree = parsed.mensaje.trim();
          } else {
            fallbackMotivo = validacion.motivo;
          }
        } catch (e) {
          console.error('JSON FREE inválido:', contenido);
          fallbackMotivo = 'json_invalido';
        }
      }

      if (!resumenfree) {
        resumenfree = construirResumenFreeLocal(alertasSeleccionadas);
        generador = 'local_seguro';
      }

      // FIX: guardar el resumenfree solo en las alertas que se usaron para generarlo
      // (no en todas las de hoy, por si llegaron alertas nuevas después)
      const idsUsados = alertasSeleccionadas.map((a) => a.id);
      const { error: updError } = await supabase
        .from('alertas')
        .update({ resumenfree })
        .in('id', idsUsados);

      if (updError) {
        console.error('Error guardando resumenfree:', updError.message);
        return res.status(500).json({ error: 'Error guardando resumenfree en BD' });
      }

      return res.json({
        success: true,
        fecha: hoy,
        procesadas: alertasSeleccionadas.length,
        candidatas_clasificadas: alertasClasificadas.length,
        descartadas_por_interes: Math.max(0, alertasClasificadas.length - alertasSeleccionadas.length),
        generador,
        fallback_motivo: fallbackMotivo,
        resumenfree,
      });
    } catch (err) {
      console.error('Error en /alertas/generar-resumen-free', err);
      return res.status(500).json({ error: err.message });
    }
  };

  app.post('/alertas/generar-resumen-free', (req, res) => {
    if (!checkCronToken(req, res)) return;
    generarResumenFreeHandler(req, res);
  });
  app.get('/alertas/generar-resumen-free', (req, res) => {
    if (!checkCronToken(req, res)) return;
    generarResumenFreeHandler(req, res);
  });

  // ============================================================
  // 2) Enviar el RESUMEN FREE por WhatsApp a usuarios FREE
  // ============================================================
  const enviarResumenFreeHandler = async (req, res) => {
    try {
      const hoy = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : getFechaMadridISO();

      // Buscar una alerta de hoy con resumenfree que no se haya enviado aún
      const { data, error } = await supabase
        .from('alertas')
        .select('id, titulo, resumen, resumen_final, url, fuente, resumenfree, estado_ia, sectores, subsectores, tipos_alerta, taxonomy_tags')
        .eq('fecha', hoy)
        .eq('estado_ia', 'listo')
        .not('resumenfree', 'is', null)
        .or('whatsapp_enviado_free.is.null,whatsapp_enviado_free.eq.false');

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      const alertaConResumenValido = buscarAlertaConResumenFreeValido(data);

      if (!alertaConResumenValido?.resumenfree) {
        return res.json({
          success: true,
          enviados: 0,
          fecha: hoy,
          mensaje: 'No hay resumen FREE pendiente para enviar',
        });
      }

      const mensajeFree = alertaConResumenValido.resumenfree;

      await enviarWhatsAppFree(supabase, mensajeFree);

      // FIX: marcar solo las alertas que tenían este resumenfree, no todas las de hoy
      const { error: updError } = await supabase
        .from('alertas')
        .update({ whatsapp_enviado_free: true })
        .eq('fecha', hoy)
        .eq('estado_ia', 'listo')
        .eq('resumenfree', mensajeFree);

      if (updError) {
        console.error('Error marcando whatsapp_enviado_free:', updError.message);
      }

      return res.json({
        success: true,
        fecha: hoy,
        enviados: 1,
        mensaje: 'Resumen FREE enviado por WhatsApp a usuarios FREE',
      });
    } catch (e) {
      console.error('Error enviar-resumen-free:', e);
      return res.status(500).json({ error: 'Error interno enviando FREE' });
    }
  };

  app.post('/alertas/enviar-resumen-free', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarResumenFreeHandler(req, res);
  });
  app.get('/alertas/enviar-resumen-free', (req, res) => {
    if (!checkCronToken(req, res)) return;
    enviarResumenFreeHandler(req, res);
  });
};

module.exports.alertaTieneTaxonomiaMinima = alertaTieneTaxonomiaMinima;
module.exports.buscarAlertaConResumenFreeValido = buscarAlertaConResumenFreeValido;
module.exports.construirResumenFreeLocal = construirResumenFreeLocal;
module.exports.evaluarCandidataResumenFree = evaluarCandidataResumenFree;
module.exports.seleccionarAlertasResumenFree = seleccionarAlertasResumenFree;
module.exports.validarResumenFreeIA = validarResumenFreeIA;
module.exports.__testing = {
  FREE_FOOTER,
  FREE_HEADER,
  fuenteResumenFree,
  normalizarTextoFree,
};
