# Contexto canónico para IA: ruralicos-api

Objetivo: localizar la lógica correcta sin cargar miles de líneas ni mezclar sistemas históricos.

## 1. Flujo vigente

Una única tarea diaria ejecuta `node scripts/run_digest_workflow.js`:

```text
/tareas/scrapers-diario
  → /tareas/cotejar-listados-oficiales          [opcional]
  → /alertas/reparar-pendientes-ia              [opcional]
  → /alertas/clasificar                         [lotes]
  → /alertas/resumir                            [lotes]
  → /alertas/revisar                            [lotes]
  → /alertas/deduplicar
  → /cerebro/embeddings/inicializar             [opcional]
  → /cerebro/ciclo-diario?explorar=false        [opcional]
  → /tareas/hold-evidence-recovery              [acotado]
  → /alertas/preparar-digest                    [lotes por usuario]
  → /alertas/enviar-digest
  → /alertas/generar-resumen-free
  → /alertas/enviar-resumen-free
  → /tareas/mia-outbox                          [cola común]
  → /tareas/whatsapp-reconcile                  [opcional]
  → /cerebro/exploracion-diaria                 [opcional y selectiva]
  → /tareas/mia-outbox                          [solo si encoló preguntas]
  → /tareas/shadow-v2                           [opcional, aislado y reanudable]
```

Si clasificación, resumen, revisión o preparación no progresan, el script falla antes del envío. MIA y listados son complementarios y pueden producir `warning` sin tumbar el digest.

Los endpoints individuales son fases o herramientas manuales, no crons adicionales. Shadow-v2 se ejecuta al final y un fallo suyo no bloquea el digest productivo.

## 2. Tarea → código → prueba

| Pregunta o cambio | Código principal | Símbolos que buscar | Pruebas |
| --- | --- | --- | --- |
| Orden del cron | `scripts/run_digest_workflow.js` | `main`, `runBatchedStep`, `runSingleStep` | `runDigestWorkflow*` |
| Fuentes y scrapers | `src/modules/boletines/`, `src/modules/tareas/tareas.routes.js` | `scrapersDiario`, ruta de la fuente | test de fuente, `scraperRunQuality` |
| Clasificar/descartar | `src/modules/alertas/alertas.service.js`, `clasificacion/` | `detectarExclusionDuraAlerta`, `clasificarLocalmente`, `clasificarConReintento` | `alertDiscardAudit`, corpus auditado |
| Evidencia/ficha | `src/modules/alertas/intelligence/` | `buildAlertFactSheet`, validadores de evidencia | `factSheet*`, `documentTrace*` |
| Provincia/sector/tipo | `src/modules/alertas/seleccion/alertaMatcher.js` | `resolverTerritorioAlerta`, `diagnosticarAlertaUsuario` | `alertaMatcher` |
| Score/bloqueos/diversidad | `src/modules/alertas/seleccion/alertSelectionEngine.js` | `aplicarBloqueosDuros`, `calcularScore`, `evaluarAlertaParaDigest` | `alertSelectionEngine`, `alertSelectionGate` |
| Preparar un digest | `src/modules/digest/digest.routes.js` | `prepararDigestHandler` | grupo `digest` |
| Texto, rescate y tracking | `src/modules/digest/digest.service.js` | `seleccionarAlertasRescate`, `generarMensajeDigest`, `prepararMensajeConLinksTracking` | `digestMessageTone`, `digestTracking` |
| Última autoridad de envío | `src/modules/digest/finalDigestValidator.js`, `finalValidationAuthority.js` | `validateFinalDigest`, `filtrarDigestsPorAutoridadFinal` | `finalDigestValidator`, `finalValidationAuthority` |
| Envío WhatsApp | `src/modules/digest/digest.routes.js`, `src/platform/whatsapp/mensajes.js` | `enviarDigestHandler`, `enviarDigestPro` | `digestOutbox`, tests WhatsApp dirigidos |
| Respuestas/clics | `src/modules/feedback/` | parser, webhook y tracking | `feedback*`, `click*` |
| Aprendizaje determinista | `src/modules/aprendizaje/` | features, prioridad, perfil | pruebas del símbolo |
| Conversación MIA | `src/modules/mia/`, `aprendizaje/cerebro.routes.js` | inbound, policy, exploración | grupo `mia` |
| Panel interno | `src/modules/admin/` | ruta usada por la pantalla | prueba dirigida + panel |
| Multi-tenant partner | `src/modules/partner/` | `requireOrg`, `tenantClient` | `partnerTenantIsolation` |

`src/routes.js` es el registro central si solo conoces una URL.

## 3. Archivos grandes: no cargarlos enteros

| Archivo | Cómo entrar |
| --- | --- |
| `digest.service.js` | Busca carga de datos, `seleccionarAlertasRescate`, validación, mensaje o tracking según la tarea |
| `digest.routes.js` | Entra por `diagnosticarDigestHandler`, `previewDigestHandler`, `prepararDigestHandler` o `enviarDigestHandler` |
| `alertas.service.js` | Separa exclusión local, normalización, ficha IA y clasificación por sus funciones |
| `alertQuality.js` | Busca el código exacto de calidad/bloqueo observado |
| `admin.mia.routes.js` | Busca primero la URL del panel o el nombre de tabla |

No refactorices un archivo grande únicamente por tamaño durante un bugfix. Extrae una pieza solo si tiene frontera clara y pruebas suficientes.

## 4. Tablas que explican un envío

| Capa | Tablas |
| --- | --- |
| Usuario | `users`, `user_interest_profile`, `user_memory`, `user_conversations` |
| Alerta/evidencia | `alertas`, `alert_fact_sheets`, documentos y trazas relacionadas |
| Decisión | `digest_attempts`, `digest_candidate_decisions` |
| Resultado | `digests`, `digest_items` |
| Entrega | `whatsapp_logs`, `mia_outbox` |
| Reacción | `alerta_click_links`, `alerta_clicks`, `alerta_feedback` |
| Operación | `scraper_runs`, `pipeline_runs` |

Orden recomendado para investigar «qué se envió hoy»:

1. `digests` + `digest_items`;
2. `whatsapp_logs`, correlacionado por hora y teléfono;
3. `digest_attempts` + `digest_candidate_decisions`;
4. `alertas` + `alert_fact_sheets`;
5. clics, feedback, conversaciones y memoria;
6. `scraper_runs` + `pipeline_runs`.

## 5. Trampas conocidas

- `alertas.fecha` es texto; `digests.fecha` es fecha. Para horas usa siempre `Europe/Madrid` de forma explícita.
- `estado_ia="listo"` no significa «se enviará»: todavía faltan audiencia, evidencia y validación final.
- `subscription="cooperativa"` es el nombre del plan, no el tipo legal del beneficiario.
- Todos los scores en 100 pueden indicar saturación; un score alto nunca anula un bloqueo.
- `whatsapp_logs.message_type="digest_pro"` ha incluido preguntas de exploración porque `cerebro.routes.js` reutiliza `enviarDigestPro`. Correlaciona con `user_conversations` antes de afirmar que hubo duplicados.
- El resumen free es una ruta distinta del digest PRO y no demuestra coincidencia individual.
- Una comunidad autónoma en `alertas.provincias` no basta para afirmar coincidencia provincial; revisa la traza territorial/evidencia.
- `pipeline_runs` no contiene necesariamente todas las fases HTTP; combina sus datos con `scraper_runs`, digests y logs.

## 6. Fuente de verdad y vigencia

Prioridad:

1. migración/código ejecutable;
2. test de regresión;
3. README junto al módulo;
4. este documento y documentación operativa vigente;
5. auditorías, planes y roadmaps fechados.

Los documentos con `roadmap`, `audit`, `rollout` o una fecha describen contexto histórico salvo que código y tests confirmen lo contrario.
