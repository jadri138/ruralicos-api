# Intelligence engine audit

## Objetivo

Auditoria inicial del flujo de alertas y digest para preparar una evolucion
evidence-first sin cambiar comportamiento. La prioridad es aumentar precision y
fiabilidad sin romper el digest actual ni perder alertas utiles por umbrales no
calibrados.

## Flujo actual resumido

1. Los scrapers capturan publicaciones y, en las rutas nuevas, registran primero
   `raw_documents`.
2. Las alertas entran en `alertas` con titulo, contenido, fuente, region,
   resumenes, tags normalizados, estado IA y embedding cuando aplica.
3. `src/modules/mia/alertQuality.js` calcula calidad operativa:
   `score`, `grade`, `critical`, `flags`, `ready_for_digest` y
   `ready_for_mia`.
4. `src/modules/digest/digest.service.js` carga alertas listas, aplica
   `filtrarAlertasPorCalidadDigest`, preferencias de usuario, aprendizaje,
   perfil operativo MIA, ranking vectorial y rescate semanal.
5. `src/modules/alertas/seleccion/alertSelectionEngine.js` decide por usuario
   con matcher, quality gate, bloqueos duros, score, razones, riesgo y
   `decision_digest`.
6. `digest.service.js` enriquece alertas finales con grupo, relevancia y
   `contexto_mia_digest`, genera mensaje local o IA y anade la instruccion fija
   de feedback.
7. `src/modules/mia/digestItems.js` guarda auditoria en `digest_items`:
   `selection_score`, `selection_action`, `selection_reason`,
   `selection_risk`, `similarity_score`, `selection_decision` y `tags_json`.
   Tiene fallback legacy si faltan columnas.
8. `digest_attempts` registra intentos, no envios, rescates y errores por
   usuario/fecha/tipo.

## Piezas que ya existen

- Quality gate con flags criticos para duplicadas, descartadas, sin URL, sin
  resumen util, notificaciones individuales, empleo publico, pesca/maritimo no
  agrario, administracion general no agraria y boilerplate.
- Motor de seleccion con matcher por preferencias, score explicable,
  diversificacion por fuente/tipo, bloqueo de licitaciones/nombramientos y
  expediente individual sin municipio o interes fuerte.
- Auditoria de seleccion en `digest_items`, incluyendo payload completo de
  `selection_decision`.
- Preview seguro de digest que no escribe, no envia WhatsApp y no registra
  `digest_items`.
- `raw_documents` y `documentTrace.js` para trazar una alerta hacia el documento
  bruto mediante `raw_documents.inserted_alerta_id -> alertas.id`.
- Preclasificador barato (`alertPreclassifier`) para separar candidatos fuertes,
  debiles, descartes por regla y casos sin evidencia.
- Respuestas MIA grounded (`groundedAnswer.js`) con evidencias `[E1]`, bloqueo de
  respuestas sin referencia valida y cautela para pagos, fechas y plazos.
- Auditoria de respuestas MIA (`answerAudit`, `replyGuard`, `qualityReport`) que
  ya usa vocabulario de evidencia trazable.

## Brechas para evidence-first

- No existe todavia una ficha maestra por alerta que normalice hechos con
  evidencia por campo.
- `documentTrace.js` aun no esta conectado a la ficha ni al digest.
- `alertQuality.js` no entiende `truth_score`, `risk_score`,
  `evidence_coverage` ni `fact_sheet_status`.
- `alertSelectionEngine.js` mezcla `action: "review"` con `incluir: true`, de
  modo que una revision puede acabar entrando en digest automatico.
- El mensaje final del digest no se valida contra una ficha de hechos despues de
  redactarse.
- No hay modo sombra para comparar "lo que habriamos bloqueado" contra lo que se
  envia hoy.
- Falta un golden dataset estable de casos agroganaderos para medir falsos
  positivos, falsos negativos, claims inventados y perdida de alertas valiosas.
- La auditoria admin puede explicar items enviados, pero aun no reconstruye de
  forma completa "por que no se envio" una alerta concreta a un usuario.

## Puntos de integracion recomendados

- Fact sheet:
  `src/modules/alertas/intelligence/factSheetBuilder.js` debe consumir la alerta
  y, cuando haya Supabase, `documentTrace.js`.
- Quality gate:
  `src/modules/mia/alertQuality.js` debe aceptar campos evidence-first como
  opcionales para mantener compatibilidad con alertas antiguas.
- Seleccion:
  `src/modules/alertas/seleccion/alertSelectionEngine.js` debe separar
  `include`, `review_only` y `exclude`.
- Digest compiler:
  `src/modules/digest/digest.service.js` debe integrar la ficha primero en modo
  sombra, despues en enforcement.
- Auditoria:
  `src/modules/mia/digestItems.js` debe guardar estados evidence-first dentro de
  `tags_json` y, si hay migracion, tambien en columnas dedicadas.
- Admin:
  las rutas admin deben leer `digest_items`, `digest_attempts`,
  `selection_decision`, fact sheet y validacion final.

## Riesgos de romper produccion

- Bloquear por `evidence_coverage` demasiado pronto puede eliminar alertas buenas
  cuyo documento bruto aun no esta enlazado.
- Endurecer `selectionEngine` sin corregir la semantica de `review` puede crear
  incoherencias: items marcados para revisar pero enviados igualmente.
- Integrar fact sheets directamente en `digest.service.js` sin fallback puede
  romper digests cuando falten tablas nuevas.
- Validar el mensaje final solo de forma global puede bloquear un digest entero
  por un item, o dejar pasar un claim inventado dentro de un bloque concreto.
- Doble IA en todas las alertas criticas puede disparar coste y latencia sin
  mejorar precision si no se activa solo en casos de riesgo.

## Principio de despliegue

Toda regla nueva que pueda reducir envios debe pasar por tres estados:

1. `observe`: calcula flags y metricas, no bloquea.
2. `shadow`: registra cual habria sido la decision evidence-first junto a la
   decision real.
3. `enforce`: bloquea solo cuando el golden dataset y la auditoria real muestren
   precision suficiente.

