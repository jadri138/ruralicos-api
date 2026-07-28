# Administración

API privada consumida por `ruralicos-panel`. Presenta datos operativos y acciones de soporte sin trasladar reglas de negocio al frontend.

## Archivos

| Archivo | Área |
| --- | --- |
| `admin.routes.js` | Agregador y login/montaje común |
| `admin.panel.routes.js` | Dashboard, digests, WhatsApp, audiencia y explicaciones |
| `admin.usuarios.routes.js` | Usuarios, organizaciones y diagnósticos |
| `admin.alertas.routes.js` | Edición, reproceso y cotejo oficial |
| `admin.operaciones.routes.js` | Scrapers, pipeline, salud y calidad |
| `admin.cerebro.routes.js` | Diagnóstico y perfil de aprendizaje |
| `admin.mia.routes.js` | Consola completa de MIA |
| `admin.helpers.js` | Piezas compartidas de consulta/formato |
| `auditLog.js` | Auditoría de acciones administrativas |
| `digestExplain.js` | “Por qué se envió/no se envió” |

## Regla de diseño

Una ruta admin puede coordinar una operación, pero debe reutilizar el servicio dueño. Por ejemplo, reprocesar una alerta no debe implementar un clasificador distinto del pipeline.

## Seguridad

- Toda ruta `/admin/*`, salvo `/admin/login`, exige `requireAdmin`.
- Las consultas deben paginar y limitar tamaños.
- No devolver hashes, tokens, claves, teléfono completo innecesario ni PII sensible.
- Mutaciones, impersonación, replay y envíos deben dejar auditoría.
- Un preview o `dry_run` no debe producir efectos.
- Errores al cargar métricas opcionales no deben ocultar fallos críticos.

## Explicabilidad

`digestExplain.js` reconstruye candidatos, decisiones, intento, elementos y envío. La explicación debe distinguir:

- no hubo alertas;
- las alertas fueron excluidas;
- falló la preparación;
- bloqueó la validación final;
- quedó en cola;
- falló la entrega.

No usar “no enviado” como una única categoría.

## Pruebas

`adminAuditLog`, `adminDigestExplain`, `adminAlertRecipients` y las pruebas del módulo sobre el que actúa cada endpoint.
