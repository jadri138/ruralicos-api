// src/routes/boe.js
//
// Scraper BOE. Captura bruta: se registran en raw_documents TODOS los items del
// sumario con título y alguna URL, ANTES de filtrar por departamento. El filtro
// por ministerio/departamento pasa a ser una preclasificación barata: lo que no
// pasa queda como skipped_by_rule (no se borra). Solo se descarga el HTML y se
// inserta en alertas para los departamentos relevantes (sin cambios de coste).

const { XMLParser } = require('fast-xml-parser');
const cheerio = require('cheerio');
const { checkCronToken } = require('../../../middleware/cronToken');
const { htmlATexto } = require('../../../shared/htmlParser');
const {
  CAPTURE_STATUS,
  actualizarRawDocumentContenido,
  registrarRawDocuments,
  marcarRawDocumentInsertado,
  marcarRawDocumentSaltado,
} = require('../rawDocuments/rawDocuments.service');

const xmlParser = new XMLParser({ ignoreAttributes: false });

// Ministerios / departamentos "del campo".
const DEPT_RELEVANTE_REGEX =
  /(AGRICULTURA|GANADER[ÍI]A|DESARROLLO RURAL|MEDIO AMBIENTE|TRANSICI[ÓO]N ECOL[ÓO]GICA|ALIMENTACI[ÓO]N|PESCA|SANIDAD)/i;

function esDepartamentoRelevante(nombre) {
  return DEPT_RELEVANTE_REGEX.test(nombre || '');
}

function extraerUrl(campo) {
  if (typeof campo === 'string') return campo;
  if (campo && typeof campo === 'object') return campo['#text'] || campo.text || null;
  return null;
}

// Recorre TODO el sumario (sin filtrar por departamento) y devuelve los items con
// título y alguna URL, con su departamento (region) para preclasificar después.
function extraerItemsSumario(sumario, fechaISO) {
  const toArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
  const items = [];
  const vistos = new Set();

  for (const diario of toArray(sumario.diario)) {
    for (const seccion of toArray(diario.seccion)) {
      for (const dept of toArray(seccion.departamento)) {
        const nombreDept = dept['@_nombre'] || dept.nombre || 'NACIONAL';

        const gruposItems = [];
        for (const epi of toArray(dept.epigrafe)) {
          const itemsEpi = toArray(epi.item);
          if (itemsEpi.length) gruposItems.push(itemsEpi);
          const itemsDispo = toArray(epi.disposicion);
          if (itemsDispo.length) gruposItems.push(itemsDispo);
        }
        const itemsDept = toArray(dept.item);
        if (itemsDept.length) gruposItems.push(itemsDept);

        for (const grupo of gruposItems) {
          for (const item of grupo) {
            if (!item) continue;
            const titulo = item.titulo;
            const urlPdf = extraerUrl(item.url_pdf);
            const urlHtml = extraerUrl(item.url_html);

            // Captura bruta: basta con título + alguna URL (PDF o HTML).
            if (!titulo || (!urlPdf && !urlHtml)) continue;

            const clave = urlPdf || urlHtml;
            if (vistos.has(clave)) continue;
            vistos.add(clave);

            items.push({
              titulo,
              url: urlPdf || urlHtml,
              url_pdf: urlPdf || null,
              url_html: urlHtml || null,
              fecha: fechaISO,
              region: nombreDept,
            });
          }
        }
      }
    }
  }

  return items;
}

const BOE_CONTENT_SELECTORS = [
  '#textoxslt',
  '#texto',
  '.documento',
  '.texto-disposicion',
  'main article',
  'article',
  'main',
  '#contenido',
];

function limpiarTextoExtraidoBoe(value) {
  return String(value || '')
    .replace(/\bAgencia Estatal Bolet[ií]n Oficial del Estado\b/gi, ' ')
    .replace(/\b(Inicio|Mi BOE|Buscar|Men[uú]|Ayuda|Contacto|Aviso legal)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extraerTextoNodoBoe($, node) {
  const clone = $(node).clone();
  clone.find([
    'script',
    'style',
    'nav',
    'header',
    'footer',
    'form',
    'aside',
    '[role="navigation"]',
    '[aria-label*="naveg"]',
    '[class*="menu"]',
    '[class*="breadcrumb"]',
    '[class*="migas"]',
    '[class*="sidebar"]',
    '[class*="acciones"]',
    '[class*="compart"]',
    '[id*="menu"]',
    '[id*="cabecera"]',
    '[id*="pie"]',
  ].join(',')).remove();

  const fragments = [];
  clone.find('h1, h2, h3, h4, p, li, dt, dd, blockquote, table tr').each((_, element) => {
    const text = limpiarTextoExtraidoBoe($(element).text());
    if (text.length >= 12 && !fragments.includes(text)) fragments.push(text);
  });

  const structured = fragments.join(' ');
  return limpiarTextoExtraidoBoe(structured || htmlATexto(clone.html() || clone.text()));
}

function extraerTextoOficialBoe(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  const candidates = [];

  for (const selector of BOE_CONTENT_SELECTORS) {
    $(selector).each((_, node) => {
      const text = extraerTextoNodoBoe($, node);
      if (text.length >= 80) candidates.push(text);
    });
  }

  if (candidates.length === 0) {
    const body = extraerTextoNodoBoe($, $('body').first().get(0));
    if (body) candidates.push(body);
  }

  return candidates
    .sort((left, right) => right.length - left.length)[0]
    ?.slice(0, 20000)
    .trim() || '';
}

async function fetchHtmlPorDefecto(url_html) {
  try {
    const resp = await fetch(url_html);
    if (!resp.ok) {
      console.error('Error HTTP al descargar HTML del BOE', resp.status, url_html);
      return null;
    }
    const html = await resp.text();
    return extraerTextoOficialBoe(html);
  } catch (e) {
    console.error('Error descargando/parsing HTML del BOE', url_html, e.message);
    return null;
  }
}

// Núcleo: registrar (bruto) → preclasificar por departamento → insertar (alertas).
// Separado de la ruta para testearlo con un supabase falso y sin red.
async function procesarItemsBoe(supabase, items, opciones = {}) {
  const fechaISO = opciones.fechaISO || null;
  const deptRelevante = opciones.deptRelevante || esDepartamentoRelevante;
  const fetchHtml = opciones.fetchHtml || fetchHtmlPorDefecto;

  // 1) Registrar TODOS los items en raw_documents (nada se pierde).
  const itemsConRaw = await registrarRawDocuments(supabase, items, { fuente: 'BOE' });

  let nuevas = 0;
  let duplicadas = 0;
  let saltadasFiltro = 0;
  let errores = 0;

  for (const item of itemsConRaw) {
    const region = item.region || 'NACIONAL';

    // 2) Preclasificación barata por departamento (no se borra: se marca).
    if (!deptRelevante(region)) {
      saltadasFiltro++;
      await marcarRawDocumentSaltado(supabase, item.raw_document_id, 'departamento_no_relevante');
      continue;
    }

    // La alerta usa la URL del PDF como clave; sin PDF queda registrado pero no
    // insertable (auditable, no perdido).
    if (!item.url_pdf) {
      await marcarRawDocumentSaltado(supabase, item.raw_document_id, 'sin_url_pdf');
      continue;
    }

    // 3) Duplicado por URL + título en BD.
    const { data: existe, error: errorExiste } = await supabase
      .from('alertas')
      .select('id')
      .eq('url', item.url_pdf)
      .eq('titulo', item.titulo)
      .limit(1);

    if (errorExiste) {
      console.error('Error comprobando alerta existente', errorExiste.message);
      errores++;
      await marcarRawDocumentSaltado(supabase, item.raw_document_id, errorExiste.message || 'dup_check_error', {
        status: CAPTURE_STATUS.ERROR,
      });
      continue;
    }

    if (existe && existe.length > 0) {
      duplicadas++;
      await marcarRawDocumentSaltado(supabase, item.raw_document_id, 'duplicate_url', {
        status: CAPTURE_STATUS.DUPLICATE,
      });
      continue;
    }

    // 4) Descargar contenido HTML del BOE (solo departamentos relevantes).
    let contenidoPlano = item.titulo;
    if (item.url_html) {
      const texto = await fetchHtml(item.url_html);
      if (texto) {
        contenidoPlano = texto.slice(0, 8000);
        await actualizarRawDocumentContenido(
          supabase,
          item.raw_document_id,
          texto
        );
      }
    }

    // 5) Insertar alerta y enlazar el raw document.
    const { data, error: errorInsert } = await supabase
      .from('alertas')
      .insert([
        {
          titulo: item.titulo,
          resumen: 'Procesando con IA...',
          estado_ia: 'pendiente_clasificar',
          url: item.url_pdf,
          fecha: fechaISO,
          region,
          fuente: 'BOE',
          contenido: contenidoPlano,
        },
      ])
      .select('id');

    if (errorInsert) {
      console.error('Error insertando alerta', errorInsert.message);
      errores++;
      await marcarRawDocumentSaltado(supabase, item.raw_document_id, errorInsert.message || 'insert_error', {
        status: CAPTURE_STATUS.ERROR,
      });
      continue;
    }

    nuevas++;
    const alertaId = Array.isArray(data) && data[0] ? data[0].id : null;
    await marcarRawDocumentInsertado(supabase, item.raw_document_id, alertaId);
  }

  return { nuevas, duplicadas, errores, saltadasFiltro };
}

function boeRoutes(app, supabase) {
  // Scraper BOE por ministerios relacionados con el medio rural
  app.get('/scrape-boe-oficial', async (req, res) => {
    if (!checkCronToken(req, res)) return;

    try {
      // 1) Fecha: ?fecha=AAAAMMDD o hoy por defecto
      let fecha = req.query.fecha;
      if (!fecha) {
        const hoy = new Date();
        const anyo = hoy.getFullYear();
        const mes = String(hoy.getMonth() + 1).padStart(2, '0');
        const dia = String(hoy.getDate()).padStart(2, '0');
        fecha = `${anyo}${mes}${dia}`;
      }

      if (!/^\d{8}$/.test(fecha)) {
        return res.status(400).json({
          error: 'Fecha inválida. Usa AAAAMMDD, por ejemplo 20240101',
          fecha_recibida: fecha,
        });
      }

      const fechaISO = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`;

      // 2) URL BOE
      const url = `https://boe.es/datosabiertos/api/boe/sumario/${fecha}`;
      console.log('Llamando a BOE con fecha:', fecha, 'URL:', url);

      const response = await fetch(url, {
        headers: { Accept: 'application/xml' },
      });

      if (response.status === 404) {
        return res.json({
          success: true,
          nuevas: 0,
          mensaje: 'No hay BOE publicado para esta fecha',
          fecha: fechaISO,
        });
      }

      if (!response.ok) {
        const text = await response.text();
        console.error('Error HTTP BOE', response.status, text);
        throw new Error(`BOE API HTTP ${response.status}`);
      }

      // 3) Parseo del XML
      const xml = await response.text();
      const json = xmlParser.parse(xml);

      const sumario = json?.response?.data?.sumario;
      if (!sumario) {
        return res.json({
          success: true,
          nuevas: 0,
          mensaje: 'No se encontró <sumario> en el XML',
          fecha: fechaISO,
        });
      }

      // 4) Recolectar TODOS los items del sumario (sin filtrar) y procesar.
      const items = extraerItemsSumario(sumario, fechaISO);
      const stats = await procesarItemsBoe(supabase, items, { fechaISO });

      res.json({ success: true, fecha: fechaISO, totales: items.length, ...stats });
    } catch (err) {
      console.error('Error en /scrape-boe-oficial', err);
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = boeRoutes;
module.exports.procesarItemsBoe = procesarItemsBoe;
module.exports.extraerItemsSumario = extraerItemsSumario;
module.exports.esDepartamentoRelevante = esDepartamentoRelevante;
module.exports.extraerTextoOficialBoe = extraerTextoOficialBoe;
