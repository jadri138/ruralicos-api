// src/modules/boletines/rutas/shared/registrarBoletinRuta.js
//
// Factoría de rutas de boletín: el esqueleto (cron token, fecha, "sin docs",
// procesado, respuesta, errores) era idéntico en ~16 ficheros de rutas/, cada
// uno con su copia de normalizar() y esRuralRelevante(). Aquí queda una sola
// vez; cada fuente aporta solo lo que varía: paths, scraper, keywords,
// procesador y mensajes.
//
// Modos de fecha (se preserva el comportamiento histórico de cada fuente):
//   'query'       → req.query.fecha o null (el scraper usa su último boletín)
//   'query-o-hoy' → req.query.fecha o hoy()
//   'hoy'         → siempre hoy() (la fuente no soporta backfill por fecha)

const { checkCronToken } = require('../../../../middleware/cronToken');
const { procesarBoletinPreclasificado } = require('./procesarBoletinPreclasificado');
const { procesarConFiltroRural } = require('./procesarConFiltroRural');
const { crearPrefiltroRural } = require('../../scrapers/shared/ruralFilter');

// Alias conservado para no obligar a cada ruta a conocer la implementación.
// La función devuelta ya no es booleana: produce pass/review/discard.
const crearFiltroRural = crearPrefiltroRural;

function registrarBoletinRuta(app, supabase, config) {
  const {
    paths,
    fuente,
    region,
    hoy,
    fechaModo = 'query',
    obtenerDocs,
    procesador = 'preclasificado',
    opciones = {},
    mensajes = {},
  } = config;

  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error(`registrarBoletinRuta(${fuente}): falta paths`);
  }
  if (typeof obtenerDocs !== 'function' || typeof hoy !== 'function') {
    throw new Error(`registrarBoletinRuta(${fuente}): faltan obtenerDocs u hoy`);
  }

  async function handler(req, res) {
    if (!checkCronToken(req, res)) return;

    try {
      const fechaQuery = req.query.fecha ? String(req.query.fecha).slice(0, 10) : null;
      const fecha =
        fechaModo === 'hoy'
          ? hoy()
          : fechaModo === 'query-o-hoy'
            ? (fechaQuery || hoy())
            : fechaQuery;

      const docs = await obtenerDocs(fecha);

      if (!docs.length) {
        return res.json({
          success: true,
          fecha: fecha || hoy(),
          totales: 0,
          documentos_insertables: 0,
          nuevas: 0,
          duplicadas: 0,
          errores: 0,
          saltadasFiltro: 0,
          mensaje: mensajes.sinDocs || `No hay boletín ${fuente} para esta fecha (sin publicación o festivo)`,
        });
      }

      const procesar = procesador === 'filtroRural'
        ? procesarConFiltroRural
        : procesarBoletinPreclasificado;

      const stats = await procesar(supabase, docs, {
        fuente,
        region,
        contenido: (doc) => doc.texto,
        ...opciones,
      });

      return res.json({
        success: true,
        fecha: docs[0]?.fecha || fecha || hoy(),
        ...stats,
        mensaje: mensajes.procesado || `${fuente} procesado (captura bruta + filtro rural)`,
      });
    } catch (e) {
      console.error(`Error en ${paths[0]}`, e);
      return res.status(500).json({ error: e.message });
    }
  }

  for (const path of paths) {
    app.get(path, handler);
  }
}

module.exports = { registrarBoletinRuta, crearFiltroRural };
