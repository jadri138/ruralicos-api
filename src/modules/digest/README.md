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
| `/alertas/enviar-digest` | Envía o encola digests preparados |

GET y POST se conservan por compatibilidad operativa; las rutas siguen protegidas por cron/admin.

## Preparación

1. Carga usuario, plan y preferencias canónicas.
2. Obtiene alertas del periodo y une fuentes de candidatas.
3. Evalúa exclusiones y selección por usuario.
4. Aplica diversidad y límites del plan.
5. Registra decisiones por candidata.
6. Genera texto claro y enlaces de tracking.
7. Ejecuta validación final.
8. Guarda digest, elementos e intento.

Un digest vacío es un resultado válido si no hay contenido suficientemente bueno. No se rellena con ruido para forzar un envío.

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

Con `DIGEST_VIA_OUTBOX=true`, `/enviar-digest` crea una entrada en `mia_outbox`; el drenador la entrega con reintentos y backoff. Sin esa opción, el envío es síncrono. En ambos casos deben existir:

- una clave que impida duplicar el mismo digest;
- estado del intento;
- motivo de no envío;
- delay anti-spam;
- relación con los elementos realmente enviados.

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

`digestCandidateDecisions`, `digestAttempts`, `digestOutbox`, `digestAutoSendGuard`, `digestNoSendReason`, `digestMessageTone`, `finalDigestValidator`, `finalValidationAuthority` y `runDigestWorkflow`.
