// src/routes/boe.js
const { XMLParser } = require('fast-xml-parser');

const xmlParser = new XMLParser({ ignoreAttributes: false });

module.exports = function boeRoutes(app, supabase) {
  // Scraper BOE por ministerios relacionados con el medio rural
  app.get('/scrape-boe-oficial', async (req, res) => {
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
          fecha_recibida: fecha
        });
      }

      const fechaISO = `${fecha.slice(0, 4)}-${fecha.slice(
        4,
        6
      )}-${fecha.slice(6, 8)}`;

      // 2) URL BOE
      const url = `https://boe.es/datosabiertos/api/boe/sumario/${fecha}`;
      console.log('Llamando a BOE con fecha:', fecha, 'URL:', url);

      const response = await fetch(url, {
        headers: { Accept: 'application/xml' }
      });

      if (response.status === 404) {
        return res.json({
          success: true,
          nuevas: 0,
          mensaje: 'No hay BOE publicado para esta fecha',
          fecha: fechaISO
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
          fecha: fechaISO
        });
      }

      const toArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);

      const diarios = toArray(sumario.diario);
      let nuevas = 0;

      // 4) MINISTERIOS / DEPARTAMENTOS “del campo”
      const deptRelevanteRegex =
        /(AGRICULTURA|GANADER[ÍI]A|DESARROLLO RURAL|MEDIO AMBIENTE|TRANSICI[ÓO]N ECOL[ÓO]GICA|ALIMENTACI[ÓO]N)/i;

      // 5) COSAS QUE INTERESAN:
      // ayudas, subvenciones, convocatorias, leyes, reales decretos, reglamentos,
      // modificaciones, corrección de errores, plazos, prórrogas…
      const keywordsInteres =
        /(ayudas?|subvenci[oó]n|subvenciones|convocatoria|bases reguladoras|extracto de la Orden|real decreto|ley\b|leyes\b|reglamento|reglamentos|modificaci[oó]n|modifica la|corrige errores|correcci[oó]n de errores|plazo|plazos|pr[oó]rroga|prorroga)/i;

      // 6) Exclusiones claras (cosas que casi seguro no quieres)
      const keywordsExcluir =
        /(pescadores?|buques pesqueros|actividad pesquera|curso de posgrado|m[aá]ster|master|CIS\b|universidad|investigaci[oó]n social)/i;

      // 7) Recorrer todo el BOE
      for (const diario of diarios) {
        const secciones = toArray(diario.seccion);

        for (const seccion of secciones) {
          const departamentos = toArray(seccion.departamento);

          for (const dept of departamentos) {
            const nombreDept =
              dept['@_nombre'] || dept.nombre || 'NACIONAL';

            // FILTRO POR MINISTERIO/DEPARTAMENTO
            if (!deptRelevanteRegex.test(nombreDept)) {
              continue;
            }

            const epigrafes = toArray(dept.epigrafe);
            const gruposItems = [];

            // Items dentro de epígrafes
            for (const epi of epigrafes) {
              const itemsEpi = toArray(epi.item);
              if (itemsEpi.length) gruposItems.push(itemsEpi);
            }

            // Items colgando directamente del departamento
            const itemsDept = toArray(dept.item);
            if (itemsDept.length) gruposItems.push(itemsDept);

            // Procesar cada ítem
            for (const grupo of gruposItems) {
              for (const item of grupo) {
                if (!item) continue;

                const titulo = item.titulo;

                // URL del PDF
                let url_pdf = null;
                if (typeof item.url_pdf === 'string') {
                  url_pdf = item.url_pdf;
                } else if (item.url_pdf && typeof item.url_pdf === 'object') {
                  url_pdf =
                    item.url_pdf['#text'] || item.url_pdf.text || null;
                }

                if (!titulo || !url_pdf) continue;

                // 8) FILTRO DE INTERÉS:
                // Tiene que parecer algo relevante (ayudas, ley, RD, modificación, plazos…)
                if (!keywordsInteres.test(titulo)) continue;

                // Y NO debe ser pesca, másters, CIS, etc.
                if (keywordsExcluir.test(titulo)) continue;

                // Evitar duplicados por URL
                const { data: existe, error: errorExiste } = await supabase
                  .from('alertas')
                  .select('id')
                  .eq('url', url_pdf)
                  .limit(1);

                if (errorExiste) {
                  console.error(
                    'Error comprobando alerta existente',
                    errorExiste.message
                  );
                  continue;
                }

                if (existe && existe.length > 0) {
                  continue;
                }

                // Insertar alerta
                const { error: errorInsert } = await supabase
                  .from('alertas')
                  .insert([
                    {
                      titulo,
                      resumen: 'Procesando con IA...',
                      url: url_pdf,
                      fecha: fechaISO,
                      region: nombreDept
                    }
                  ]);

                if (errorInsert) {
                  console.error(
                    'Error insertando alerta',
                    errorInsert.message
                  );
                  continue;
                }

                nuevas++;
              }
            }
          }
        }
      }

      res.json({ success: true, nuevas, fecha: fechaISO });
    } catch (err) {
      console.error('Error en /scrape-boe-oficial', err);
      res.status(500).json({ error: err.message });
    }
  });
};
