# MIA

Asistente inteligente de Ruralicos. Entiende mensajes de WhatsApp, consulta contexto verificable, clasifica intención, propone una respuesta o acción y conserva memoria estructurada con límites de seguridad.

MIA no es un único prompt: es una cadena auditable de entrada, decisión, política, conocimiento, respuesta, acción y entrega.

## Flujo entrante

```text
webhook UltraMsg
  → webhookEvent: deduplicación
  → inbound: normalización y persistencia
  → feedbackClassifier / decisionCore
  → policy: acción permitida, confirmación o bloqueo
  → groundedAnswer / knowledgeBase
  → replyGuard + answerAudit
  → actionExecutor
  → outbox
  → WhatsApp
```

Si una parte falla, se conserva el caso y la trazabilidad; no se ejecuta silenciosamente una acción distinta.

## Capacidades por grupo

| Grupo | Archivos |
| --- | --- |
| Entrada | `webhookEvent.js`, `inbound.js`, `feedbackClassifier.js` |
| Decisión | `decisionCore.js`, `policy.js`, `decisionStore.js`, `expertRelevance.js` |
| Contexto | `userProfile.js`, `organizationContext.js`, `structuredMemory.js` |
| Conocimiento | `knowledgeBase.js`, `knowledgeIngest.js`, `groundedAnswer.js` |
| Alertas/digest | `alertQuality.js`, `alertReview.js`, `digestItems.js`, `digestAttempts.js`, `digestCandidateDecisions.js` |
| Ejecución | `actionExecutor.js`, `outbox.js`, `replyGuard.js` |
| Calidad | `answerAudit.js`, `qualityReport.js`, `evalHarness.js`, `replay.js`, `recommendationHealth.js` |
| Personalización | `exploration.js` |

## Comprensión sin ser pesada

El parser admite respuestas naturales y referencias a varias alertas, no solo “sí/no”. Según confianza y contexto puede:

- registrar interés o desinterés;
- explicar una alerta;
- aclarar cuál de varias alertas quiere valorar;
- actualizar una preferencia permitida;
- consultar o borrar memoria;
- abrir un caso si no puede resolver con seguridad.

La respuesta debe ser corta, útil y proporcional. MIA no repite preguntas ya contestadas, no fuerza una valoración y no convierte cada mensaje en un formulario.

## Política y acciones

Cada decisión tiene intención, confianza, evidencia, acción propuesta y razón. `policy.js` determina:

- acciones automáticas seguras;
- acciones que necesitan confirmación;
- acciones bloqueadas;
- respuesta ante ambigüedad;
- cuándo crear un caso operativo.

`actionExecutor.js` solo ejecuta acciones enumeradas. El modelo no recibe acceso libre a la base de datos ni a WhatsApp.

## Memoria

Se separan:

- conversación reciente;
- memoria estructurada con tipo, valor, confianza, origen y vigencia;
- preferencias explícitas de cuenta;
- perfil aprendido y señales agregadas.

Una inferencia no debe sobrescribir una preferencia explícita. El usuario puede consultar y borrar memoria desde `/me/memory`.

## Conocimiento y respuestas

`knowledgeBase` combina documentos autorizados, alertas y contexto. `groundedAnswer` exige respaldo; `replyGuard` elimina riesgos antes de enviar. Si no hay evidencia suficiente, la respuesta debe reconocerlo y remitir al documento oficial.

## Calidad sin revisión manual constante

El sistema reduce la carga humana mediante:

- evaluaciones automáticas;
- auditoría de respuestas;
- replay de eventos;
- casos solo para excepciones;
- salud de outbox y recomendaciones;
- snapshots históricos;
- umbrales y bloqueos conservadores.

Esto no hace que el sistema sea literalmente infalible, pero evita depender de revisar cada mensaje uno a uno y permite encontrar patrones de fallo.

## Operación

El panel `/cerebro`, `/aprendizaje` y `/conocimiento` muestra overview, trazas, casos, decisiones, acciones, memoria, outbox, conocimiento, calidad y replay. Las mutaciones se auditan.

## Pruebas

Los archivos `mia*.test.js` cubren cada pieza. Ante un cambio de decisión o política, ejecutar al menos decision core, policy, inbound, reply guard, action executor, structured memory, grounded answer, evals y replay.
