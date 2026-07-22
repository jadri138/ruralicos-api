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
const {
  clasificarRelacionDocumental,
  esActualizacion,
  esCorreccion,
  esRelacionDuplicada,
} = require('./intelligence/documentRelation');

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
      const lookbackDays = Math.max(
        1,
        Math.min(365, Number(req.query.lookback_days || process.env.DEDUP_LOOKBACK_DAYS || 120))
      );
      const desde = new Date(`${fecha}T00:00:00.000Z`);
      desde.setUTCDate(desde.getUTCDate() - lookbackDays);
      const fechaDesde = desde.toISOString().slice(0, 10);

      // La alerta autonómica y su republicación estatal no tienen por qué caer
      // el mismo día. Se compara el objetivo con una ventana histórica acotada.
      const { data: alertas, error } = await supabase
        .from('alertas')
        .select('id, titulo, fuente, fecha, contenido, resumen, resumen_final, estado_ia, decision_audit')
        .gte('fecha', fechaDesde)
        .lte('fecha', fecha)
        .eq('estado_ia', 'listo')
        .order('id', { ascending: true });

      if (error) return res.status(500).json({ error: error.message });
      const alertasObjetivo = (alertas || []).filter((alerta) => alerta.fecha === fecha);
      if (alertasObjetivo.length === 0 || !alertas || alertas.length < 2) {
        return res.json({
          ok: true,
          fecha,
          lookback_days: lookbackDays,
          umbral,
          dry_run: dryRun,
          mensaje: alertasObjetivo.length === 0
            ? 'Sin alertas listas para la fecha objetivo'
            : 'Sin candidatos historicos o diarios para relacionar',
          deduplicadas: 0,
        });
      }

      // Agrupación greedy por similitud. Se parte de las alertas objetivo para
      // que un grupo puramente histórico no consuma antes su candidato.
      alertas.sort((a, b) =>
        Number(b.fecha === fecha) - Number(a.fecha === fecha) || Number(a.id) - Number(b.id)
      );
      const asignadas = new Set();
      const grupos = [];

      for (let i = 0; i < alertas.length; i++) {
        if (asignadas.has(alertas[i].id)) continue;

        const grupo = [alertas[i]];
        asignadas.add(alertas[i].id);

        for (let j = i + 1; j < alertas.length; j++) {
          if (asignadas.has(alertas[j].id)) continue;
          const sim = similitudTitulos(alertas[i].titulo, alertas[j].titulo);
          const relation = clasificarRelacionDocumental(alertas[i], alertas[j], {
            sameSubjectThreshold: umbral,
          });
          if (sim >= umbral || relation.relation !== 'new_document') {
            grupo.push(alertas[j]);
            asignadas.add(alertas[j].id);
          }
        }

        if (grupo.length > 1 && grupo.some((alerta) => alerta.fecha === fecha)) grupos.push(grupo);
      }

      if (grupos.length === 0) {
        return res.json({
          ok: true,
          fecha,
          lookback_days: lookbackDays,
          umbral,
          dry_run: dryRun,
          mensaje: 'Sin duplicados detectados',
          deduplicadas: 0,
        });
      }

      // Elegir el canónico de cada grupo y actualizar las demás
      let deduplicadas = 0;
      let relacionadas = 0;
      const detalle = [];

      for (const grupo of grupos) {
        // El original siempre precede a correcciones/actualizaciones. Solo
        // entre documentos del mismo nivel se aplica autoridad y resumen.
        grupo.sort((a, b) => {
          const derivedDiff = Number(esCorreccion(a) || esActualizacion(a))
            - Number(esCorreccion(b) || esActualizacion(b));
          if (derivedDiff !== 0) return derivedDiff;
          const diff = prioridadFuente(b.fuente) - prioridadFuente(a.fuente);
          if (diff !== 0) return diff;
          return (b.resumen_final ? 1 : 0) - (a.resumen_final ? 1 : 0);
        });

        const canonico = grupo[0];
        const duplicados = grupo.slice(1);

        const detalleGrupo = {
          canonico: { id: canonico.id, fuente: canonico.fuente, titulo: canonico.titulo },
          relaciones: [],
        };
        detalle.push(detalleGrupo);

        for (const dup of duplicados) {
          const relation = clasificarRelacionDocumental(canonico, dup, {
            sameSubjectThreshold: umbral,
          });
          const duplicateRelation = esRelacionDuplicada(relation.relation);
          detalleGrupo.relaciones.push({
            id: dup.id,
            fuente: dup.fuente,
            relation: relation.relation,
            evidence: relation.evidence,
          });
          if (dryRun) {
            if (duplicateRelation) deduplicadas++;
            else relacionadas++;
            continue;
          }

          const patch = {
            decision_audit: {
              ...(dup.decision_audit || {}),
              document_relation: {
                version: 'document_relation_v1',
                canonical_alert_id: canonico.id,
                relation: relation.relation,
                evidence: relation.evidence,
              },
            },
          };
          if (duplicateRelation) {
            patch.estado_ia = 'duplicado';
            patch.duplicado_de = canonico.id;
          }
          const { error: upErr } = await supabase
            .from('alertas')
            .update(patch)
            .eq('id', dup.id);

          if (upErr) {
            console.error(`[deduplicar] Error marcando alerta ${dup.id}:`, upErr.message);
          } else {
            if (duplicateRelation) deduplicadas++;
            else relacionadas++;
          }
        }
      }

      console.log(`[deduplicar] ${fecha}: ${grupos.length} grupos, ${deduplicadas} alertas ${dryRun ? 'detectadas' : 'marcadas como duplicadas'}`);
      return res.json({
        ok: true,
        fecha,
        lookback_days: lookbackDays,
        umbral,
        dry_run: dryRun,
        grupos: grupos.length,
        deduplicadas,
        relacionadas,
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
