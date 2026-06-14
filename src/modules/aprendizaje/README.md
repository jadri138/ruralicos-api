# modules/aprendizaje

Aprendizaje **ligero y determinista** del sistema: a partir del feedback del
usuario y de las características de las alertas, calcula prioridades y un perfil
de intereses que afina la selección del digest.

No es un LLM: son reglas, keywords y scores. Para el **agente conversacional**
(LLM, decisiones, memoria) ver [`../mia/`](../mia/README.md).

## Piezas

- `feedbackParser.js` — interpreta los votos del digest (`+1 -2`, "bien 1 y 3"…).
- `alertPriority.js` — clasifica la prioridad de una alerta (urgente/…/baja).
- `alertFeatures.js` — extrae features (conceptos, entidades) de una alerta.
- `userInterestProfile.js` — perfil de intereses del usuario a partir del histórico.
- `miaProfile.js` — perfil/embedding del usuario para ordenación.
- `taxonomiaRuralicos.js` — taxonomía de sectores/subsectores rurales.
- `cerebro.js` + `cerebro.routes.js` — perfilado, embeddings y exploración
  (endpoints `/cerebro/*`). El nombre "cerebro" es anterior a la separación
  con `mia/`; aquí no hay conversación.
- `index.js` — superficie pública del módulo.

## Dónde encaja

Lo usan principalmente `digest/` (para ordenar y priorizar alertas por usuario)
y `feedback/` (para registrar votos). Ver la frontera completa en
[docs/ARQUITECTURA.md](../../../docs/ARQUITECTURA.md#frontera-aprendizaje-brain--mia).
