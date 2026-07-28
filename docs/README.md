# Documentación de la API

Índice de documentos largos. Los README junto al código explican el estado actual de cada carpeta; estos documentos profundizan en arquitectura, operación y decisiones de diseño.

## Empezar

| Documento | Para quién | Contenido |
| --- | --- | --- |
| [`EXPLICACION_SIMPLE.md`](EXPLICACION_SIMPLE.md) | No técnico | Qué hace el sistema con lenguaje sencillo |
| [`ARQUITECTURA.md`](ARQUITECTURA.md) | Desarrollo | Capas, módulos y flujo general |
| [`TESTING_LOCAL.md`](TESTING_LOCAL.md) | Desarrollo | Guía de pruebas locales |
| [`VALIDACION_LOCAL_COMPLETA.md`](VALIDACION_LOCAL_COMPLETA.md) | Entrega | Checklist de validación amplia |
| [`render_quick_start.md`](render_quick_start.md) | Operación | Puesta en marcha en Render |

## Inteligencia, filtros y recomendación

| Documento | Tema |
| --- | --- |
| [`sistema_recomendacion_inteligente.md`](sistema_recomendacion_inteligente.md) | Selección y personalización |
| [`SISTEMA_APRENDIZAJE_INTELIGENTE.md`](SISTEMA_APRENDIZAJE_INTELIGENTE.md) | Señales y aprendizaje |
| [`fact-sheet.md`](fact-sheet.md) | Ficha de hechos verificables |
| [`document-trace.md`](document-trace.md) | Trazabilidad desde la fuente |
| [`final-digest-validator.md`](final-digest-validator.md) | Validación previa al envío |
| [`ARQUITECTURA_EMBEDDINGS.md`](ARQUITECTURA_EMBEDDINGS.md) | Vectores y similitud |
| [`intelligence-engine-audit.md`](intelligence-engine-audit.md) | Auditoría del motor |
| [`intelligence-engine-roadmap.md`](intelligence-engine-roadmap.md) | Evolución prevista |
| [`intelligence-enforcement-runbook.md`](intelligence-enforcement-runbook.md) | Activación/operación de controles |

## Pipeline y tareas

| Documento | Tema |
| --- | --- |
| [`cron_digest_setup.md`](cron_digest_setup.md) | Programación del digest |
| [`cron_complementarios_setup.md`](cron_complementarios_setup.md) | Fuentes complementarias |
| [`pipeline_tick_rollout.md`](pipeline_tick_rollout.md) | Runner con checkpoints |
| [`p0-acceptance-runbook.md`](p0-acceptance-runbook.md) | Ejecución de aceptación P0 |
| [`p0-acceptance-matrix.md`](p0-acceptance-matrix.md) | Garantías y casos |
| [`p0-hardening-roadmap.md`](p0-hardening-roadmap.md) | Endurecimiento P0 |

## Cumplimiento y planes técnicos

| Documento | Tema |
| --- | --- |
| [`CUMPLIMIENTO.md`](CUMPLIMIENTO.md) | Privacidad y retención |
| [`revised-technical-plan-implementation.md`](revised-technical-plan-implementation.md) | Plan técnico implementado |

## Contrato HTTP

[`openapi.json`](openapi.json) se genera con:

```powershell
npm run openapi:generar
```

Después de cambiar rutas, ejecutar también `npm run rutas:inventario`. El código y el inventario prevalecen si un documento histórico no coincide.

## Vigencia

Los archivos llamados `roadmap`, `plan` o `audit` describen una fecha o una intención. No deben interpretarse automáticamente como comportamiento activo. Para saber qué está en producción:

1. revisar el README del módulo;
2. comprobar código y tests;
3. comprobar migraciones/variables;
4. verificar el despliegue.

Al modificar una función, actualizar el README cercano y el documento profundo correspondiente sin duplicar explicaciones contradictorias.
