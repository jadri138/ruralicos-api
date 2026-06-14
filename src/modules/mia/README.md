# modules/mia

**Agente conversacional** de Ruralicos. Procesa los mensajes entrantes de
WhatsApp, decide qué responder con un LLM (con grounding y guardas), ejecuta
acciones y mantiene memoria estructurada.

Es el sistema "inteligente y no determinista". Para el aprendizaje **por
keywords/score** (prioridad de alertas, perfil de intereses) ver
[`../aprendizaje/`](../aprendizaje/README.md).

## Piezas principales

- `inbound.js` — registra y normaliza el mensaje entrante.
- `decisionCore.js` / `policy.js` — deciden la acción/respuesta y aplican política.
- `groundedAnswer.js` / `replyGuard.js` — respuesta fundamentada y guardas de calidad.
- `knowledgeBase.js` / `knowledgeIngest.js` — base de conocimiento (manuales, semántica).
- `structuredMemory.js` / `userProfile.js` / `organizationContext.js` — memoria y contexto.
- `actionExecutor.js` / `decisionStore.js` — ejecución y persistencia de decisiones.
- `outbox.js` — cola de salida de mensajes (reintentos, health).
- `digestItems.js` / `digestAttempts.js` — soporte al digest desde el lado MIA.
- `alertQuality.js` / `alertReview.js` / `expertRelevance.js` — evaluación de alertas.
- `evalHarness.js` / `qualityReport.js` / `answerAudit.js` / `replay.js` — evaluación y auditoría.

## Dónde encaja

Lo consume `feedback/` (webhook entrante) y el panel `admin/` (sección `/admin/mia/*`
para trazabilidad). Frontera con `aprendizaje/` en
[docs/ARQUITECTURA.md](../../../docs/ARQUITECTURA.md#frontera-aprendizaje-brain--mia).
