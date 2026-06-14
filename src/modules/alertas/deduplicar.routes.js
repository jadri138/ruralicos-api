// Deduplicación de alertas del día.
//
// Detecta alertas con títulos muy similares (Jaccard ≥ 0.65) publicadas el mismo día
// por distintos boletines (p.ej. BOE + BOJA publican el mismo Real Decreto).
// Mantiene la alerta más autoritativa y marca las demás como 'duplicado'.
//
// Autoridad: BOE > autonómicos (boa, bocyl, boja, doe, docm, borm, …)
// Dentro del mismo nivel: se prefiere la que ya tiene resumen_final.
//
// Uso en pipeline: llamar despues de /alertas/revisar y antes de /alertas/preparar-digest.

const { checkCronToken }  = require('../../middleware/cronToken');
const { similitudTitulos } = require('../../shared/similitud');
const { getFechaMadridISO } = require('../../shared/fechaMadrid');

const UMBRAL_DEFAULT = 0.65;

// Mayor índice = más autoritativa
const FUENTES_ORDEN = ['borm', 'docm', 'doe', 'boja', 'bocyl', 'boa', 'boe'];
function prioridadFuente(fuente) {
  const f = (fuente || '').toLowerCase();
  const idx = FUENTES_ORDEN.findIndex(s => f.includes(s));
  return idx === -1 ? 0 : idx + 1;
}

module.exports = function deduplicarRoutes(app, supabase) {

  const handler = async (req, res) => {
    try {
      const hoy = getFechaMadridISO();
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(req.query.fecha || '')
        ? req.query.fecha
        : hoy;
      const umbral = Number.isFinite(Number(req.query.umbral))
        ? Number(req.query.umbral)
        : Number(process.env.DEDUP_UMBRAL || UMBRAL_DEFAULT);
      const dryRun = String(req.query.dry_run || '').toLowerCase() === 'true';

      // Solo alertas listas (no las que ya son duplicados ni las pendientes)
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, fuente, resumen_final, estado_ia')
        .eq('fecha', fecha)
        .eq('estado_ia', 'listo')
        .order('id', { ascending: true });

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length < 2) {
        return res.json({
          ok: true,
          fecha,
          umbral,
          dry_run: dryRun,
          mensaje: 'Menos de 2 alertas listas, nada que deduplicar',
          deduplicadas: 0,
        });
      }

      // Agrupación greedy por similitud
      const asignadas = new Set();
      const grupos = [];

      for (let i = 0; i < alertas.length; i++) {
        if (asignadas.has(alertas[i].id)) continue;

        const grupo = [alertas[i]];
        asignadas.add(alertas[i].id);

        for (let j = i + 1; j < alertas.length; j++) {
          if (asignadas.has(alertas[j].id)) continue;
          const sim = similitudTitulos(alertas[i].titulo, alertas[j].titulo);
          if (sim >= umbral) {
            grupo.push(alertas[j]);
            asignadas.add(alertas[j].id);
          }
        }

        if (grupo.length > 1) grupos.push(grupo);
      }

      if (grupos.length === 0) {
        return res.json({
          ok: true,
          fecha,
          umbral,
          dry_run: dryRun,
          mensaje: 'Sin duplicados detectados',
          deduplicadas: 0,
        });
      }

      // Elegir el canónico de cada grupo y actualizar las demás
      let deduplicadas = 0;
      const detalle = [];

      for (const grupo of grupos) {
        // Ordenar: mayor autoridad primero; empate → prefiere la que tiene resumen_final
        grupo.sort((a, b) => {
          const diff = prioridadFuente(b.fuente) - prioridadFuente(a.fuente);
          if (diff !== 0) return diff;
          return (b.resumen_final ? 1 : 0) - (a.resumen_final ? 1 : 0);
        });

        const canonico = grupo[0];
        const duplicados = grupo.slice(1);

        detalle.push({
          canonico:   { id: canonico.id, fuente: canonico.fuente, titulo: canonico.titulo },
          duplicados: duplicados.map(d => ({ id: d.id, fuente: d.fuente })),
        });

        for (const dup of duplicados) {
          if (dryRun) {
            deduplicadas++;
            continue;
          }

          const { error: upErr } = await supabase
            .from('alertas')
            .update({ estado_ia: 'duplicado', duplicado_de: canonico.id })
            .eq('id', dup.id);

          if (upErr) {
            console.error(`[deduplicar] Error marcando alerta ${dup.id}:`, upErr.message);
          } else {
            deduplicadas++;
          }
        }
      }

      console.log(`[deduplicar] ${fecha}: ${grupos.length} grupos, ${deduplicadas} alertas ${dryRun ? 'detectadas' : 'marcadas como duplicadas'}`);
      return res.json({
        ok: true,
        fecha,
        umbral,
        dry_run: dryRun,
        grupos: grupos.length,
        deduplicadas,
        detalle,
      });

    } catch (err) {
      console.error('Error en /alertas/deduplicar:', err);
      return res.status(500).json({ error: err.message });
    }
  };

  app.get('/alertas/deduplicar',  (req, res) => { if (!checkCronToken(req, res)) return; handler(req, res); });
  app.post('/alertas/deduplicar', (req, res) => { if (!checkCronToken(req, res)) return; handler(req, res); });
};
