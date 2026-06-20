# Intelligence engine roadmap

## Comparacion con el plan original

El plan original acierta en cuatro decisiones:

- separar fases por archivos permitidos y prohibidos;
- no tocar el digest hasta tener ficha y validador;
- guardar auditoria de seleccion y validacion;
- reservar doble IA para el final.

Pero necesita ajustes para llegar a una fiabilidad alta:

- debe partir de `raw_documents` y `documentTrace.js`, no solo de `alertas`;
- debe crear un golden dataset antes de endurecer reglas;
- debe introducir modo sombra antes de bloquear envios;
- debe corregir la semantica actual donde `action: "review"` cuenta como
  `incluir: true`;
- debe reutilizar los guardarrailes grounded de MIA para no duplicar criterios;
- debe medir coste, latencia, cobertura y falsos positivos en cada fase.

## Contrato de fiabilidad

Una alerta solo puede enviarse automaticamente cuando se cumplen estas
condiciones:

- fuente oficial o traza documental suficiente;
- objeto administrativo claro;
- territorio no inventado;
- sector/subsector no inventado;
- accion requerida no inventada;
- plazo, importe y beneficiarios solo si tienen evidencia textual;
- URL oficial presente;
- calidad operativa suficiente;
- decision de seleccion `include`, no `review_only`;
- validacion final del mensaje correcta.

Si falta evidencia para un campo, el campo debe quedar `null`, `no_verificado`
o lista vacia. Nunca se completa por intuicion.

## Estados normalizados

Para evitar ambiguedades entre modulos:

- `include`: puede ir a digest automatico.
- `review_only`: valor potencial, pero necesita revision o modo preview.
- `blocked`: no debe enviarse.
- `insufficient_evidence`: no hay materia prima para afirmar hechos sensibles.

`review_only` no debe tratarse como `include` en el digest automatico.

## Fase 0 - Auditoria inicial

Responsable: Codex.

Estado: documentada en `docs/intelligence-engine-audit.md`.

No cambia comportamiento. Debe dejar claro:

- flujo actual;
- piezas existentes;
- brechas evidence-first;
- puntos de integracion;
- riesgos de produccion.

## Fase 1 - Golden dataset de fiabilidad

Responsable: Codex.

Estado: arnes no destructivo creado en:

- `src/modules/alertas/intelligence/goldenDataset.js`
- `tests/intelligenceGoldenDataset.test.js`

Crear fixtures y tests con casos representativos:

- curso de bienestar animal;
- ayuda/subvencion con plazo claro;
- ayuda/subvencion sin plazo claro;
- PAC/FEGA/SIGPAC;
- agua/riego general;
- concesion de aguas individual;
- sancion individual;
- alerta generica;
- alerta sin URL;
- alerta con provincia no demostrada;
- alerta con sector no demostrado;
- licitacion de bajo valor;
- usuario con preferencias incompletas;
- usuario con exclusion explicita.

Cada fixture debe declarar:

- decision esperada: `include`, `review_only` o `blocked`;
- razones esperadas;
- campos sensibles que no se pueden inventar;
- si el caso debe activar fact sheet, final validator o doble check.

## Fase 2 - Ficha maestra evidence-first

Responsable: Codex.

Estado: primera version aislada creada en:

- `src/modules/alertas/intelligence/factSheetSchema.js`
- `src/modules/alertas/intelligence/factSheetBuilder.js`
- `src/modules/alertas/intelligence/factSheetValidator.js`
- `tests/factSheetValidator.test.js`
- `docs/fact-sheet.md`

Crear modulos nuevos:

- `src/modules/alertas/intelligence/factSheetSchema.js`
- `src/modules/alertas/intelligence/factSheetBuilder.js`
- `src/modules/alertas/intelligence/factSheetValidator.js`
- `docs/fact-sheet.md`
- tests dedicados.

La ficha debe incluir:

- `schema_version`
- `builder_version`
- `alerta_id`
- `raw_document_id`
- `content_hash`
- `url_oficial`
- `tipo_documento`
- `tema_principal`
- `resumen_neutro`
- `territorio`
- `sectores`
- `subsectores`
- `accion_requerida`
- `plazo`
- `beneficiarios`
- `importe`
- `requisitos`
- `evidencias`
- `truth_score`
- `risk_score`
- `evidence_coverage`
- `status`
- `flags`
- `reasons`

Cada campo factual debe tener `{ valor, evidencia, source, confidence }` o un
valor vacio explicito.

Regla clave: `factSheetBuilder` debe usar `documentTrace.js` cuando sea posible.
Si no hay raw document, puede construir ficha parcial desde alerta, pero debe
marcar menor cobertura.

## Fase 3 - Persistencia y shadow mode

Responsable: Codex.

Estado: persistencia opcional creada en:

- `src/modules/alertas/intelligence/factSheetStore.js`
- `supabase/migrations/20260620120000_add_alert_fact_sheets.sql`
- `tests/factSheetStore.test.js`

Crear persistencia versionada opcional para fact sheets, con fallback si la tabla
no existe. Recomendacion: `alert_fact_sheets`.

Guardar en modo sombra:

- ficha generada;
- decision evidence-first teorica;
- decision actual;
- diferencia;
- flags y reasons.

No bloquear todavia. La salida debe permitir responder: "esta alerta se envio,
pero la nueva politica la habria dejado en revision por X".

## Fase 4 - Endurecer quality gate

Responsable: Codex.

Estado: implementado de forma compatible en:

- `src/modules/mia/alertQuality.js`
- `tests/miaAlertQuality.test.js`

Modificar solo:

- `src/modules/mia/alertQuality.js`
- `tests/miaAlertQuality.test.js`

Reglas iniciales:

- `fact_sheet_status = "blocked"` marca critical.
- `truth_score < 85` anade `truth_score_bajo`.
- `risk_score > 35` anade `risk_score_alto`.
- `evidence_coverage < 0.6` anade `evidencia_insuficiente`.
- alertas sin fact sheet conservan comportamiento actual.

Activacion recomendada:

- flags en `observe` primero;
- critical solo para `blocked`;
- enforcement de umbrales tras pasar golden dataset.

## Fase 5 - Seleccion prudente

Responsable: Codex.

Estado: implementado en:

- `src/modules/alertas/seleccion/alertSelectionEngine.js`
- `tests/alertSelectionEngine.test.js`
- `src/modules/alertas/intelligence/goldenDataset.js`

Modificar:

- `src/modules/alertas/seleccion/alertSelectionEngine.js`
- `tests/alertSelectionEngine.test.js`

Cambios:

- introducir `review_only` separado de `include`;
- mantener `decision_digest.action`;
- anadir `sendable` o ajustar `incluir` para que solo sea true en envio
  automatico;
- riesgo alto nunca entra automatico;
- ayudas/subvenciones/PAC/plazos solo entran si tienen calidad suficiente y sin
  flags criticos;
- razones claras: provincia, sector, tipo, expediente individual, evidencia
  insuficiente, revision por riesgo alto.

Nota critica: hoy `verdict.action === "review"` produce `incluir: true`. Esta es
la correccion principal antes de integrar evidence-first.

## Fase 6 - Validador final de mensaje

Responsable: Codex, aislado.

Estado: implementado de forma aislada en:

- `src/modules/digest/finalDigestValidator.js`
- `tests/finalDigestValidator.test.js`
- `docs/final-digest-validator.md`

Crear:

- `src/modules/digest/finalDigestValidator.js`
- `tests/finalDigestValidator.test.js`
- `docs/final-digest-validator.md`

Debe validar por item y por mensaje completo:

- menciones de plazo requieren plazo verificado;
- menciones de importe requieren importe verificado;
- menciones de territorio requieren territorio verificado;
- "te afecta" requiere match fuerte;
- ayuda/subvencion requiere convocatoria, beneficiarios o base suficiente;
- URL oficial obligatoria para envio automatico;
- `factSheet.status = blocked` bloquea;
- `decision_digest.action = review_only` no envia automatico;
- frases genericas quedan `review_only` o `blocked`;
- claims obligatorios solo si hay evidencia fuerte.

Debe reutilizar vocabulario de `groundedAnswer.js`: evidencia trazable,
referencias validas y cautela para plazos/pagos/fechas.

## Fase 7 - Integracion digest en sombra

Responsable: Codex.

Estado: implementada en modo sombra en:

- `src/modules/digest/digest.service.js`
- `src/modules/digest/digest.routes.js`
- `src/modules/mia/digestItems.js`
- `tests/digestFinalValidationShadow.test.js`
- `tests/miaDigestItems.test.js`

Modificar:

- `src/modules/digest/digest.service.js`
- `src/modules/digest/digest.routes.js`
- `src/modules/mia/digestItems.js`
- tests de digest.

Primero solo shadow:

- construir/cargar fact sheet;
- validar ficha;
- redactar digest como hoy;
- validar mensaje final;
- guardar auditoria en `tags_json`;
- no bloquear envios salvo `fact_sheet_status = blocked` si ya se decide activar.

Campos a guardar:

- `fact_sheet_status`
- `truth_score`
- `risk_score`
- `evidence_coverage`
- `final_validation_status`
- `final_validation_flags`
- `final_validation_reasons`
- `shadow_decision`

## Fase 8 - Integracion digest en enforcement

Responsable: Codex.

Estado: implementada con enforcement gradual en:

- `src/modules/digest/digest.service.js`
- `src/modules/digest/digest.routes.js`
- `tests/digestFinalValidationShadow.test.js`
- `tests/digestAttempts.test.js`

Activar bloqueo gradual:

- excluir items `blocked`;
- dejar `review_only` fuera de digest automatico;
- si fallan todos los items, no enviar digest;
- registrar `motivo_no_envio` en `digest_attempts`;
- conservar fallback si tablas nuevas no existen.

No cambiar envio WhatsApp salvo para evitar items inseguros.

### Despliegue shadow-first (importante)

Por defecto `DIGEST_FINAL_VALIDATION_ENFORCEMENT=false`: la validacion final corre en
modo SOMBRA (audita y registra en `digest_attempts` / `tags_json` que habria bloqueado,
pero NO suprime ningun envio). Esto evita perdidas silenciosas de digest mientras se mide
el ratio de falsos positivos sobre datos reales.

Para activar el bloqueo real, poner `DIGEST_FINAL_VALIDATION_ENFORCEMENT=true` SOLO despues
de revisar varios dias de sombra y confirmar que no se descartan digests legitimos
(ayudas nacionales, alertas que dicen "agricultores", PAC sin plazo, etc.).

## Fase 9 - Auditoria admin

Responsable: Codex.

Estado: implementada en:

- `src/modules/admin/digestExplain.js`
- `src/modules/admin/admin.panel.routes.js`
- `tests/adminDigestExplain.test.js`

Crear endpoints para:

- `GET /admin/digest/why-sent`
- `GET /admin/digest/why-not-sent`

Deben devolver:

- decision de seleccion;
- calidad;
- fact sheet;
- validacion final;
- mensaje usado;
- motivo de bloqueo o envio;
- diferencias shadow/enforcement.

## Fase 10 - Feedback learner

Responsable: Codex.

Estado: implementada sin bloqueo en:

- `src/modules/mia/feedbackClassifier.js`
- `src/modules/mia/actionExecutor.js`
- `supabase/migrations/20260620123000_add_feedback_classification.sql`
- `tests/feedbackClassifier.test.js`
- `tests/miaActionExecutor.test.js`

Clasificar feedback negativo:

- `wrong_topic`
- `wrong_location`
- `too_generic`
- `misclassification`
- `individual_case_noise`
- `user_profile_missing`
- `useful`
- `unclear`

No bloquear todavia por feedback. Primero usarlo para enriquecer evals y mejorar
preferencias/perfil.

## Fase 11 - Doble IA selectiva

Responsable: Codex.

Estado: implementada y apagada por defecto salvo ENV en:

- `src/modules/alertas/intelligence/criticalDoubleCheck.js`
- `src/modules/digest/digest.service.js`
- `src/modules/mia/digestItems.js`
- `tests/criticalDoubleCheck.test.js`
- `tests/digestFinalValidationShadow.test.js`

Aplicar solo cuando haya riesgo alto:

- ayudas;
- subvenciones;
- PAC;
- fiscalidad;
- sanidad animal;
- agua/riego;
- sanciones relevantes;
- plazos;
- baja cobertura de evidencia;
- discrepancia entre ficha y mensaje;
- claim sensible.

Si IA A e IA B discrepan en tipo, territorio, plazo, beneficiarios, importe,
accion requerida o sector/subsector, estado `blocked_review`.

Debe activarse con ENV:

- `ENABLE_CRITICAL_DOUBLE_CHECK=true`

## Orden recomendado

1. Codex: Fase 0.
2. Codex: Fase 1.
3. Codex: Fase 2.
4. Codex: Fase 3.
5. Codex: Fase 4.
6. Codex: Fase 5.
7. Codex: Fase 6.
8. Codex: Fase 7.
9. Codex: Fase 8.
10. Codex: Fase 9.
11. Codex: Fase 10.
12. Codex: Fase 11.

## Reglas para no pisarse

- No modificar archivos fuera de la lista de cada fase.
- Si una fase necesita un archivo prohibido, parar y justificar.
- No hacer refactors generales.
- No cambiar nombres publicos sin migracion y tests.
- Mantener fallback para tablas/columnas nuevas.
- Ejecutar tests especificos antes de checks amplios.
- Tras cambios de backend, ejecutar `graphify update .`.

## Definition of done

La mejora se considera lista solo cuando:

- golden dataset cubre todos los casos criticos;
- fact sheet nunca inventa campos sin evidencia;
- `review_only` no se envia automatico;
- el digest no contiene plazos, importes, beneficiarios, territorio o afectacion
  sin evidencia;
- `digest_items` permite auditar por que se envio cada item;
- `digest_attempts` permite auditar por que no se envio un digest;
- admin puede explicar sent/not sent;
- feedback negativo se clasifica y alimenta evals;
- doble IA solo se usa en alertas criticas o inciertas;
- los tests de calidad, seleccion, digest, fact sheet y validador final pasan.
