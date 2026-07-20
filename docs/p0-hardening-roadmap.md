# Hoja de ruta canónica de saneamiento P0

## Propósito y corte de la revisión

Este documento fija la numeración y el alcance canónicos del saneamiento P0 de
`ruralicos-api` a partir del commit
`d40d0cafb9c21afc55e6a84f97fb16a291e80fe5` (20 de julio de 2026).

La revisión se ha hecho sobre el historial Git, el código, las migraciones, los
scripts, las pruebas y la documentación presentes en el repositorio. No se ha
consultado ni modificado producción, por lo que «implementado en el repositorio»
no significa «desplegado o ejecutado en producción».

P0.1 a P0.5 ya estaban definidos. P0.6, P0.7 y P0.8 se proponen y se definen por
primera vez en este documento; no se presupone una P0.6 anterior.

## Conclusión ejecutiva

P0.1 a P0.5 están implementados y cuentan con pruebas focalizadas en el
repositorio. La lógica revisada cubre las garantías solicitadas, incluida la
protección contra fallbacks que conviertan alertas retenidas en `listo`.

El P0 de código no equivale todavía a un cierre operativo completo. Antes de un
despliegue deben cerrarse tres frentes:

1. una aceptación integral y reproducible de P0 sobre el artefacto a desplegar;
2. el saneamiento histórico de descartes y la validación controlada de la
   restricción que actualmente se crea como `NOT VALID`;
3. la operación y monitorización de `pendiente_revision_manual` y
   `needs_evidence`, sin reintroducirlos en el bucle automático de IA.

## Cobertura real de P0.1 a P0.5

### P0.1 — Coherencia y diagnóstico de taxonomía

**Estado en el repositorio:** implementado.

**Commits que construyen el alcance:**

- `bbda919`: bloqueo de taxonomía mínima ausente y propagación del diagnóstico;
- `781cfdd`: inferencia sectorial desde subsectores y diagnóstico de
  incompatibilidades;
- `add1f7e`: consolidación de la coherencia sector/subsector en un módulo común.

**Cobertura comprobada:**

- normalización canónica de sectores, subsectores y tipos;
- inferencia de agricultura o ganadería desde subsectores fuertes;
- prioridad de una preferencia sectorial explícita frente a una inferida;
- tratamiento neutral de subsectores transversales o desconocidos;
- bloqueo de alertas sin taxonomía mínima o con taxonomía incoherente antes del
  scoring;
- registro de `taxonomy_validation` y generación coherente de `taxonomy_tags`;
- propagación de los motivos de bloqueo al matcher y al motor de selección.

**Evidencia principal:**

- `src/shared/sectorTaxonomy.js`
- `src/shared/taxonomyRegistry.js`
- `src/modules/alertas/seleccion/alertaMatcher.js`
- `src/modules/alertas/seleccion/alertSelectionEngine.js`
- `tests/alertaMatcher.test.js`
- `tests/alertSelectionEngine.test.js`

**Límite o riesgo residual:** las equivalencias e inferencias son catálogos
estáticos y pueden divergir si se añaden taxones por otra ruta. Su exactitud en
datos históricos o reales no queda demostrada solo por las pruebas unitarias.

### P0.2 — Expansión autonómica y prioridad territorial

**Estado en el repositorio:** implementado.

**Commit principal:** `7a2e557`. Aunque el asunto del commit menciona la
recuperación BOPA, su diff también contiene P0.2 y sus pruebas.

**Cobertura comprobada:**

- expansión de comunidades autónomas a sus provincias;
- cobertura explícita de Extremadura, Cataluña y Aragón, entre otras;
- prioridad territorial: nacional explícito, provincia concreta detectada en el
  texto oficial, provincia explícita, comunidad autónoma, fuente y, por último,
  `region`;
- una provincia concreta en título o contenido restringe una declaración
  autonómica más amplia;
- diagnóstico del territorio original, normalizado y de su origen.

**Evidencia principal:**

- `src/modules/alertas/seleccion/alertaMatcher.js`
- `tests/alertaMatcher.test.js`

**Límite o riesgo residual:** `alertaMatcher.js` mantiene catálogos geográficos
propios mientras `src/shared/geography.js` contiene otro catálogo utilizado por
la inteligencia de fichas. Hoy las pruebas cubren el matcher, pero la duplicidad
puede provocar deriva futura entre selección y extracción de hechos.

### P0.3 — Recuperación de evidencia documental de BOPA

**Estado en el repositorio:** implementado como captura y recuperación segura;
su ejecución sobre un histórico real es una operación separada.

**Commit principal:** `7a2e557`.

**Cobertura comprobada:**

- detección del error real del portal, HTML de carga y otros placeholders;
- recuperación escalonada desde HTML y PDF oficiales;
- rechazo de PDF inválido, ilegible o que contiene HTML;
- persistencia de intentos y procedencia de la evidencia en `raw_documents`;
- uso de `needs_evidence` cuando no existe texto oficial útil;
- recuperador con dry-run por defecto y escritura solo con `--apply`;
- actualización de la misma alerta a `pendiente_clasificar` únicamente cuando se
  recupera evidencia;
- una recuperación fallida conserva `needs_evidence` y queda auditada;
- repetición segura del recuperador sobre una alerta ya recuperada.

**Evidencia principal:**

- `src/modules/boletines/scrapers/BOPA/bopaScraper.js`
- `src/modules/boletines/scrapers/BOPA/bopaEvidenceRecovery.js`
- `scripts/recover_bopa_evidence.js`
- `tests/bopaEvidence.test.js`

**Límite o riesgo residual:** el recuperador es manual, procesa como máximo 100
candidatas por invocación y aplica el límite antes de ordenar localmente el
resultado. Sin inventario, paginación determinista y seguimiento operativo, un
backlog grande puede quedar parcialmente atendido. No hay evidencia en el
repositorio de que se haya ejecutado sobre producción.

### P0.4 — Barrera de relevancia rural para DOGC y DOE

**Estado en el repositorio:** implementado.

**Commits principales:**

- `80bc1ac`: barrera de relevancia oficial antes de `listo`;
- `a957a26`: metadatos oficiales reales, estados retenidos, observabilidad y
  reproceso administrativo.

**Cobertura comprobada:**

- ámbito limitado de forma explícita a DOGC y DOE;
- uso exclusivo de título, contenido y metadatos oficiales disponibles;
- carga segura de organismo, sección, boletín e identificador desde columnas
  reales de `raw_documents`, y de subsección o tipo documental desde
  `metadata_json` cuando existen;
- exclusión diagnóstica de resúmenes, sectores, subsectores, tipos,
  `taxonomy_tags` y demás etiquetas generadas como evidencia rural;
- descarte auditable de las seis familias de ruido conocidas;
- continuidad normal para normativa, ayudas y convocatorias con evidencia rural
  expresa;
- retención como `pendiente_revision_manual` o `needs_evidence` cuando no basta
  la evidencia;
- exclusión de ambos estados del procesamiento automático y del fallback a
  `listo`;
- localización, conteo y reproceso manual desde las herramientas administrativas;
- ausencia de una restricción de estado en la base de datos que sea incompatible
  con esos dos valores.

**Evidencia principal:**

- `src/modules/alertas/clasificacion/officialRuralEvidenceGate.js`
- `src/modules/alertas/clasificacion/officialAlertMetadata.js`
- `src/modules/alertas/alertPipelineStates.js`
- `src/modules/alertas/alertas.routes.js`
- `src/modules/admin/admin.alertas.routes.js`
- `src/modules/admin/admin.operaciones.routes.js`
- `src/modules/digest/digest.routes.js`
- `tests/officialRuralEvidenceGate.test.js`
- `tests/alertDiscardAudit.test.js`

**Límite o riesgo residual:** es una barrera basada en reglas y solo cubre DOGC y
DOE. La disponibilidad de metadatos depende de la captura en `raw_documents`.
Faltan métricas operativas de falsos positivos, falsos negativos y antigüedad de
las colas retenidas; ampliar fuentes sin esas métricas aumentaría el riesgo de
bloquear alertas agrarias legítimas.

### P0.5 — Descartes estructurados y reparación histórica

**Estado en el repositorio:** contrato de escritura implementado; reparación y
validación histórica preparadas, no acreditadas como ejecutadas en producción.

**Commits principales:**

- `23ee61c`: contrato común de descarte, migración, reparación y prueba de
  productores;
- `d40d0ca`: conservación de auditoría al reclasificar, semántica segura de
  `--page-size` y SQL protegido de validación.

**Cobertura comprobada:**

- todo descarte nuevo debe conservar `discard_reason_code`, `discard_reason`,
  `discard_stage`, `discard_confidence` y `decision_audit`;
- productores normales, legacy, gratuitos y administrativos usan
  `construirDescarteAuditable`;
- `NO IMPORTA` queda como compatibilidad visual y no decide el estado;
- la reclasificación conserva la auditoría anterior usando una proyección real
  de Supabase;
- reparación histórica dry-run por defecto, `--apply` explícito, paginación
  declarada y fallback honesto `legacy_unstructured_discard`;
- reparación idempotente y sin inferir un descarte solo por el resumen;
- prueba contractual que detecta productores directos fuera del constructor;
- restricción de base de datos para impedir descartes nuevos incompletos;
- validación manual protegida para ejecutarse solo después de una reparación sin
  fallos.

**Evidencia principal:**

- `src/modules/alertas/clasificacion/discardDecision.js`
- `src/modules/alertas/clasificacion/legacyDiscardRepair.js`
- `scripts/repair_legacy_alert_discards.js`
- `scripts/sql/validate_alert_discard_constraint.sql`
- `supabase/migrations/20260719021749_add_auditable_alert_discard_fields.sql`
- `supabase/migrations/20260720120000_enforce_structured_alert_discards.sql`
- `tests/alertDiscardAudit.test.js`
- `tests/discardTraceabilityContract.test.js`

**Límite o riesgo residual:** la restricción se añade como `NOT VALID` para no
bloquear filas históricas. Protege nuevas escrituras, pero el cierre histórico no
termina hasta ejecutar la reparación sin fallos, comprobar su idempotencia y
validar la restricción en cada entorno objetivo. El repositorio no demuestra que
esas operaciones se hayan realizado fuera del entorno local.

## Comprobaciones realizadas en esta revisión

Se ejecutaron únicamente las suites focalizadas necesarias para comprobar P0.1
a P0.5:

```text
node tests/alertaMatcher.test.js                 40 aprobadas, 0 fallidas
node tests/alertSelectionEngine.test.js          29 aprobadas, 0 fallidas
node tests/bopaEvidence.test.js                  14 aprobadas, 0 fallidas
node tests/officialRuralEvidenceGate.test.js      1 aprobada,  0 fallidas
node tests/alertDiscardAudit.test.js             22 aprobadas, 0 fallidas
node tests/discardTraceabilityContract.test.js    8 aprobadas,  0 fallidas
Total                                           114 aprobadas, 0 fallidas
```

No se ejecutaron scrapers, recuperadores con `--apply`, reparaciones, SQL contra
una base remota, crons, digests, WhatsApp ni despliegues.

## Siguientes pasos P0 necesarios antes del despliegue

Los números siguientes constituyen la nueva propuesta canónica. Deben completarse
en orden, porque P0.7 consume el inventario y los criterios de P0.6, y P0.8 debe
estar operativo antes de exponer el nuevo flujo a datos reales.

### P0.6 — Gate integral de aceptación y línea base

**Objetivo:** convertir las garantías dispersas de P0.1 a P0.5 en un único gate
reproducible sobre el SHA exacto que vaya a desplegarse.

**Problema que resuelve:** las suites focalizadas prueban cada pieza, pero todavía
no existe un criterio canónico de liberación que combine lint, suite completa,
corpus oficial conocido, compatibilidad de esquema e inventario de datos a
sanear. Sin esa línea base se puede desplegar código correcto sobre un estado de
datos desconocido.

**Archivos aproximados afectados:**

- `docs/p0-hardening-roadmap.md`
- un nuevo runbook o checklist bajo `docs/`
- `tests/alertaMatcher.test.js`
- `tests/bopaEvidence.test.js`
- `tests/officialRuralEvidenceGate.test.js`
- `tests/alertDiscardAudit.test.js`
- `tests/discardTraceabilityContract.test.js`
- posibles fixtures oficiales mínimos bajo `tests/fixtures/`
- posibles consultas diagnósticas de solo lectura bajo `scripts/sql/`

**Riesgo:** medio. El mayor riesgo es aceptar un corpus demasiado pequeño o usar
como verdad campos generados por IA. Los fixtures de P0.4 deben conservar solo
título, contenido y metadatos oficiales como prueba de relevancia.

**Criterio de terminado:**

- el SHA candidato pasa lint, todas las pruebas y las comprobaciones de esquema
  locales o de staging;
- existe una matriz versionada que relaciona cada garantía P0 con al menos una
  prueba;
- el corpus incluye los seis negativos reales de P0.4, controles agrarios
  positivos, expansión territorial, incoherencias taxonómicas, BOPA sin/con
  evidencia y descartes legacy;
- ninguna positiva agraria del corpus queda descartada o retenida por P0.4;
- ninguna alerta retenida alcanza `listo` por revisión, rescate IA o fallback;
- se registra, sin modificar datos, el volumen por estado, fuente y completitud
  de descartes del entorno objetivo;
- el resultado y el SHA quedan anexados al checklist de despliegue.

### P0.7 — Reparación histórica y validación de descartes

**Objetivo:** cerrar P0.5 en datos, no solo en productores de código, y dejar
validada `alertas_structured_discard_check`.

**Problema que resuelve:** las filas históricas pueden seguir sin trazabilidad y
la restricción `NOT VALID` no certifica el histórico. Una ejecución masiva sin
ensayo también puede generar carga, fallos parciales o una falsa impresión de
éxito.

**Archivos aproximados afectados:**

- `src/modules/alertas/clasificacion/legacyDiscardRepair.js`
- `scripts/repair_legacy_alert_discards.js`
- `scripts/sql/validate_alert_discard_constraint.sql`
- `supabase/migrations/20260719021749_add_auditable_alert_discard_fields.sql`
- `supabase/migrations/20260720120000_enforce_structured_alert_discards.sql`
- runbook de despliegue bajo `docs/`

**Riesgo:** alto. Implica lectura completa, actualización histórica y validación
de una restricción sobre `alertas`. Debe planificarse la carga, el bloqueo y la
recuperación ante fallos, y ejecutarse con credenciales y ventana controladas.

**Criterio de terminado:**

- migraciones ensayadas en una copia representativa o staging;
- dry-run archivado con totales, reparables, desconocidos y fallos;
- revisión de una muestra de motivos deducidos y de
  `legacy_unstructured_discard`;
- `--apply` termina con cero fallos en el entorno objetivo;
- una segunda ejecución no encuentra filas reparables;
- la consulta protegida de validación no encuentra incumplimientos;
- `alertas_structured_discard_check` figura como validada en catálogo;
- existe evidencia de rollback o recuperación y del resultado final;
- la operación de producción se realiza solo dentro del despliegue aprobado, no
  como backfill informal previo.

### P0.8 — Operación de alertas retenidas y observabilidad P0

**Objetivo:** asegurar que `pendiente_revision_manual` y `needs_evidence` sean
colas operables, con responsable y tiempo de respuesta, y que los descartes
estructurados puedan auditarse por fuente y motivo.

**Problema que resuelve:** el código ya hace visibles y reprocesables los estados,
pero una cola sin propietario, antigüedad o umbral de alerta puede convertirse en
un descarte silencioso. Enviar `needs_evidence` automáticamente a IA resolvería
el síntoma rompiendo la garantía de evidencia oficial.

**Archivos aproximados afectados:**

- `src/modules/alertas/alertPipelineStates.js`
- `src/modules/alertas/alertas.routes.js`
- `src/modules/admin/admin.alertas.routes.js`
- `src/modules/admin/admin.operaciones.routes.js`
- un runbook P0 bajo `docs/`
- posibles consultas diagnósticas de solo lectura bajo `scripts/sql/`
- panel administrativo solo si los endpoints actuales no bastan para la
  operación acordada

**Riesgo:** medio. El riesgo funcional es reprocesar sin evidencia o crear un
bucle automático; el riesgo operativo es dejar alertas válidas retenidas sin
atención.

**Criterio de terminado:**

- se asignan propietario, frecuencia de revisión y SLA para ambos estados;
- se monitorizan total, antigüedad máxima y evolución por fuente;
- se documenta cómo localizar, revisar, aportar evidencia y reprocesar una
  alerta, y cómo descartar manualmente con motivo estructurado;
- una alerta `needs_evidence` no se envía a IA hasta que una acción explícita
  aporte evidencia y la reprograme;
- una alerta en revisión manual solo vuelve al pipeline por acción
  administrativa explícita;
- existen umbrales de alerta para crecimiento o envejecimiento de las colas y
  para descartes `legacy_unstructured_discard` nuevos;
- un canario confirma que solo `listo` entra en el digest general y que no hay
  promociones por fallback desde estados retenidos.

## Mejoras posteriores al despliegue

Estas mejoras son valiosas, pero no bloquean el despliegue si P0.6 a P0.8 están
cerrados. No se les asigna todavía un número P0 para no ampliar el alcance crítico
sin evidencia operativa.

### Unificar la geografía compartida

Extraer la expansión autonómica, alias, municipios y provincias por fuente a una
única fuente de verdad consumida por `alertaMatcher.js` y
`src/shared/geography.js`. Debe conservarse la precedencia territorial actual con
pruebas de paridad antes del cambio.

### Robustecer la recuperación BOPA

Añadir orden y paginación deterministas, métricas de intentos y antigüedad, y una
política de reintento limitada. Cualquier automatización debe mantener el dry-run
operativo, la trazabilidad en `raw_documents` y la prohibición de avanzar sin
evidencia oficial.

### Calibrar y, solo después, ampliar la barrera rural

Medir falsos positivos y falsos negativos por fuente antes de ajustar reglas o
incorporar boletines distintos de DOGC y DOE. Una ampliación debe comenzar en
modo diagnóstico y contar con positivos agrarios específicos de la nueva fuente.

### Actualizar la documentación general de estados

El resumen de estados de alertas en `README.md` no describe de forma completa el
modelo actual (`pendiente_clasificar`, `pendiente_resumir`, `pendiente_revisar`,
`pendiente_revision_manual`, `needs_evidence`, `listo` y `descartado`). Debe
alinearse con `alertPipelineStates.js` sin cambiar comportamiento.

## Tareas de otras hojas de ruta, no de P0

Las siguientes líneas de trabajo no deben mezclarse con el saneamiento P0:

- despliegue `shadow`, `critical` o `enforce` del motor de inteligencia y del
  validador final, descrito en `docs/intelligence-engine-roadmap.md` y
  `docs/intelligence-enforcement-runbook.md`;
- cutover, cron y operación de `pipeline-tick`, descritos en
  `docs/pipeline_tick_rollout.md`;
- evolución de fact sheets, doble comprobación IA, aprendizaje MIA, memoria,
  feedback o personalización del ranking;
- nuevas fuentes de boletines o cambios generales de scraping que no sean una
  corrección demostrada de P0.3 o P0.4;
- rediseños del panel administrativo, mensajería, WhatsApp, digests o producto;
- optimizaciones generales de rendimiento, seguridad, RLS, retención o
  arquitectura que no sean necesarias para completar P0.6 a P0.8.

Estas tareas pueden compartir métricas o fixtures con P0, pero deben conservar su
propio plan, criterios de rollout y autorización operativa.
