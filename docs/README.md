# Documentación de la API

Índice de documentos largos. Los README junto al código explican el estado actual de cada carpeta; estos documentos profundizan en arquitectura, operación y decisiones de diseño.

## Empezar

| Documento | Para quién | Contenido |
| --- | --- | --- |
| [`AI_CONTEXT.md`](AI_CONTEXT.md) | IA/desarrollo | Mapa mínimo: tarea, símbolos, tablas, pruebas y trampas |
| [`EXPLICACION_SIMPLE.md`](EXPLICACION_SIMPLE.md) | No técnico | Qué hace el sistema con lenguaje sencillo |
| [`ARQUITECTURA.md`](ARQUITECTURA.md) | Desarrollo | Capas, módulos y flujo general |
| [`TESTING_LOCAL.md`](TESTING_LOCAL.md) | Desarrollo | Guía de pruebas locales |
| [`cron_digest_setup.md`](cron_digest_setup.md) | Operación | Cron, Render, fuentes y vigilancia |

## Inteligencia, filtros y recomendación

| Documento | Tema |
| --- | --- |
| [`fact-sheet.md`](fact-sheet.md) | Ficha de hechos verificables |
| [`document-trace.md`](document-trace.md) | Trazabilidad desde la fuente |
| [`final-digest-validator.md`](final-digest-validator.md) | Validación previa al envío |
| [`ARQUITECTURA_EMBEDDINGS.md`](ARQUITECTURA_EMBEDDINGS.md) | Vectores y similitud |
| [`intelligence-enforcement-runbook.md`](intelligence-enforcement-runbook.md) | Activación/operación de controles |

## Diseño futuro

| Documento | Estado | Tema |
| --- | --- | --- |
| [`DECISION_V2_ARCHITECTURE.md`](DECISION_V2_ARCHITECTURE.md) | Diseño acordado, pendiente de implementar | Arquitectura objetivo del nuevo motor de decisión por usuario y despliegue inicial en sombra |
| [`PROMPT_DECISION_V2_NEXT_SESSION.md`](PROMPT_DECISION_V2_NEXT_SESSION.md) | Prompt de continuidad | Instrucciones listas para retomar la reconstrucción de `decision-v2` en otra sesión |
| [`BLUEPRINT_SISTEMA_DECISION_ALERTAS_LLM.md`](BLUEPRINT_SISTEMA_DECISION_ALERTAS_LLM.md) | Propuesta, no implementado | Diseño integral desde una alerta ya creada hasta su decisión, envío y aprendizaje. Scrapers fuera de alcance |

## Validación

| Documento | Tema |
| --- | --- |
| [`p0-acceptance-runbook.md`](p0-acceptance-runbook.md) | Ejecución de aceptación P0 |
| [`p0-acceptance-matrix.md`](p0-acceptance-matrix.md) | Garantías y casos |

## Cumplimiento

| Documento | Tema |
| --- | --- |
| [`CUMPLIMIENTO.md`](CUMPLIMIENTO.md) | Privacidad y retención |

## Contrato HTTP

[`openapi.json`](openapi.json) se genera con:

```powershell
npm run openapi:generar
```

Después de cambiar rutas, ejecutar también `npm run rutas:inventario`. El código y el inventario prevalecen si un documento histórico no coincide.

## Vigencia

Para saber qué está en producción:

1. revisar el README del módulo;
2. comprobar código y tests;
3. comprobar migraciones/variables;
4. verificar el despliegue.

Al modificar una función, actualizar el README cercano y el documento profundo correspondiente sin duplicar explicaciones contradictorias.
