# Feedback y clics

Captura las señales que deja el usuario después de recibir un digest. Alimenta aprendizaje y MIA sin tratar cada interacción como una orden absoluta.

## Archivos

| Archivo | Función |
| --- | --- |
| `clicks.routes.js` | Enlaces de tracking, redirección al documento y consulta reciente |
| `feedback.routes.js` | Webhook, parser, simulación y diagnóstico |
| `feedback.service.js` | Persistencia y aplicación de la valoración |

## Clics

Cada enlace usa un token opaco asociado a usuario, digest y alerta. Al abrirlo:

1. se valida el token;
2. se registra el clic de forma idempotente;
3. se redirige a la URL oficial;
4. el aprendizaje recibe una señal positiva moderada, no una preferencia definitiva.

Las rutas `/?a=`, `/a/:token` y `/alerta/:token` se registran antes que otras rutas raíz.

## Respuestas

El webhook acepta mensajes como valoraciones numéricas, referencias a posiciones y lenguaje natural. La clasificación conserva:

- alerta o alertas referidas;
- valor/señal;
- categoría;
- confianza;
- fragmento y contexto;
- si necesita aclaración.

Una respuesta ambigua no debe repartir una señal fuerte a todas las alertas.

## Seguridad

- Validar `ULTRAMSG_WEBHOOK_TOKEN`.
- Deduplicar eventos del proveedor.
- Normalizar teléfono y evitar PII en logs.
- No confiar en campos de identidad enviados por el cliente.
- Mantener endpoints de prueba protegidos para admin/cron.

Pruebas: `feedbackParser`, `feedbackClassifier`, `clickLearningWeight`, `ultramsgParser` y pruebas de inbound/webhook de MIA.
