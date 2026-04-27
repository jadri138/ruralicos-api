// Deduplicación de alertas del día.
//
// Detecta alertas con títulos muy similares (Jaccard ≥ 0.65) publicadas el mismo día
// por distintos boletines (p.ej. BOE + BOJA publican el mismo Real Decreto).
// Mantiene la alerta más autoritativa y marca las demás como 'duplicado'.
//
// Autoridad: BOE > autonómicos (boa, bocyl, boja, doe, docm, borm, …)
// Dentro del mismo nivel: se prefiere la que ya tiene resumen_final.
//
// Uso en pipeline: llamar DESPUÉS de /alertas/procesar-ia y ANTES de /alertas/preparar-digest.

const { checkCronToken }  = require('../utils/checkCronToken');
const { similitudTitulos } = require('../utils/similitud');

const UMBRAL = 0.65;

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
      const hoy = new Date().toISOString().slice(0, 10);

      // Solo alertas listas (no las que ya son duplicados ni las pendientes)
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, fuente, resumen_final, estado_ia')
        .eq('fecha', hoy)
        .eq('estado_ia', 'listo')
        .order('id', { ascending: true });

      if (error) return res.status(500).json({ error: error.message });
      if (!alertas || alertas.length < 2) {
        return res.json({ ok: true, mensaje: 'Menos de 2 alertas listas, nada que deduplicar', deduplicadas: 0 });
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
          if (sim >= UMBRAL) {
            grupo.push(alertas[j]);
            asignadas.add(alertas[j].id);
          }
        }

        if (grupo.length > 1) grupos.push(grupo);
      }

      if (grupos.length === 0) {
        return res.json({ ok: true, mensaje: 'Sin duplicados detectados', deduplicadas: 0 });
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

      console.log(`[deduplicar] ${hoy}: ${grupos.length} grupos, ${deduplicadas} alertas marcadas como duplicadas`);
      return res.json({ ok: true, fecha: hoy, grupos: grupos.length, deduplicadas, detalle });

    } catch (err) {
      console.error('Error en /alertas/deduplicar:', err);
      return res.status(500).json({ error: err.message });
    }
  };

  app.get('/alertas/deduplicar',  (req, res) => { if (!checkCronToken(req, res)) return; handler(req, res); });
  app.post('/alertas/deduplicar', (req, res) => { if (!checkCronToken(req, res)) return; handler(req, res); });
};
