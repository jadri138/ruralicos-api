# Digest

Construye el resumen que recibe cada usuario. Es la última frontera entre las alertas candidatas y un envío real.

## Archivos

| Archivo | Función |
| --- | --- |
| `digest.routes.js` | Preparación, diagnóstico, preview y envío |
| `digest.service.js` | Selección integrada, composición, enlaces y persistencia |
| `finalDigestValidator.js` | Validación del conjunto y del texto final |
| `digestOutbox.js` | Encolado idempotente para entrega asíncrona |

## Endpoints

| Endpoint | Uso |
| --- | --- |
| `/alertas/preparar-digest` | Crea digests pendientes por usuario |
| `/alertas/diagnosticar-digest` | Explica candidatos, filtros y ausencia de envío |
| `/alertas/preview-digest` | Simula sin entregar |
| `/alertas/enviar-digest` | Encola de forma idempotente los digests aprobados |

GET y POST se conservan por compatibilidad operativa; las rutas siguen protegidas por cron/admin.

## Preparación

1. La fase previa `/tareas/hold-evidence-recovery` recupera los
   `HOLD_FOR_EVIDENCE` vencidos sobre material ya almacenado. Persiste cada
   estrategia, backoff y agotamiento; una ficha recuperada queda
   marcada como
   `READY_FOR_REEVALUATION`/`RECOVERED` y vuelve a evaluarse aquí.
2. Carga usuario, plan, preferencias y memoria atómica.
3. Une candidatas exactas, semánticas, de memoria, cobertura y exploración sin
   perder su procedencia.
4. Aplica barreras y ranking determinista; solo el top K llega al juez.
5. Adapta y valida la ficha de hechos con evidencia por campo.
6. Ejecuta el juez personal con salida estructurada y segunda opinión selectiva.
   Reutiliza una decisión solo si la huella, contratos, versiones y modelo son
   idénticos, y respeta un presupuesto diario configurable. Los `HOLD` causados
   por indisponibilidad, presupuesto, salida inválida, abstención o desacuerdo
   se reclaman aquí con lease, backoff y un máximo de intentos; al agotarse
   terminan en silencio seguro y auditable.
7. La autoridad final aplica idempotencia, frecuencia, repetición, diversidad y
   portfolio.
8. Genera el texto únicamente desde hechos aprobados, añade tracking y ejecuta
   la validación final determinista.
9. Guarda digest, elementos, decisiones e intento.

Un digest vacío es un resultado válido si no hay contenido suficientemente bueno. No se rellena con ruido para forzar un envío.

`ALERT_DECISION_TOP_K` limita el conjunto valorado por el juez (10 por defecto,
con rango efectivo 1..20). `ALERT_DECISION_LLM_DAILY_CALL_LIMIT` limita juez y
segunda opinión, y `ALERT_DECISION_JUDGE_PRICING_JSON` permite calcular coste
solo con tarifas aportadas por el equipo. El portfolio conserva solo el cupo
del plan; no rellena con ruido cuando faltan candidatas aprobadas.

Cuando el límite diario es positivo, cada llamada lógica se reserva de forma
atómica en Supabase antes de contactar al proveedor. Si no se puede comprobar o
reservar el presupuesto, el juez se cierra de forma segura y no hace la llamada.
`HOLD_RECOVERY_MAX_LOOPS` limita los lotes de evidencias pendientes que vacía el
workflow diario. `ALERT_DECISION_HOLD_MAX_RETRIES` y las variables
`ALERT_DECISION_HOLD_RETRY_*` controlan por separado los fallos transitorios del
juez personal. Ambos ciclos viven en el mismo workflow diario y no envían nada
por sí mismos.

## Validación final

`DIGEST_FINAL_VALIDATION_MODE`:

- `shadow`: calcula el veredicto y mide, sin bloquear.
- `critical`: bloquea únicamente fallos críticos.
- `enforce`: aplica toda la política configurada.

Revisa, entre otros:

- coincidencia entre IDs, elementos y texto;
- geografía/sector y exclusiones;
- evidencia documental para cada eje temático que provocó el match (sector,
  subsector y tipo), no solo para uno cualquiera;
- evidencia y URLs;
- duplicados;
- lenguaje engañoso o promesas no respaldadas;
- calidad mínima;
- autoridad de una decisión previa auditada.

## Entrega e idempotencia

`/enviar-digest` siempre crea una entrada en `mia_outbox`; ya no existe modo
síncrono ni la variable `DIGEST_VIA_OUTBOX`. El único workflow diario prepara
también FREE, drena la cola y después concilia estados. Si la fase posterior
elige alguna pregunta selectiva para un digest ya entregado, reutiliza el mismo
drenador una segunda vez; no existe otro transporte ni otro cron. Cada mensaje
conserva:

- una clave que impida duplicar el mismo digest;
- estado del intento;
- motivo de no envío;
- delay anti-spam;
- relación con los elementos realmente enviados.

El HTTP 200 de UltraMsg solo produce `PROVIDER_ACCEPTED`. `digests.enviado`
se sella cuando llega ACK `device` (`DELIVERED`) o `read` (`READ`). Los estados,
el endpoint y la conciliación se describen en `../delivery/README.md`.

Cada intento guarda además `decision_version`. Cuando cambia de forma material
el motor de filtros o la validación, una versión nueva reabre una sola vez los
intentos `no_send`/`failed` creados por la versión anterior. Los digests ya
generados o enviados siguen siendo inmutables: una reparación nunca los duplica.

## Explicabilidad

`digest_attempts`, `digest_items` y `digest_candidate_decisions` permiten contestar:

- qué se consideró;
- qué se descartó y por qué;
- qué se eligió;
- qué validador actuó;
- si se envió o no;
- qué clic/feedback recibió después.

## Pruebas clave

`alertDecisionCore`, `digestDecisionIntegration`, `decisionEvidenceRecovery`,
`digestDecisionMessage`, `digestCandidateDecisions`, `digestAttempts`,
`digestOutbox`, `digestAutoSendGuard`, `digestNoSendReason`,
`finalDigestValidator`, `finalValidationAuthority`, `whatsappDelivery` y
`runDigestWorkflow`.
