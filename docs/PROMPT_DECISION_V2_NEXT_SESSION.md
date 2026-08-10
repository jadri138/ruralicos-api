# Prompt de continuidad: reconstrucción de decision-v2

> Estado: encargo histórico ya implementado en modo sombra. Para activar,
> ejecutar y consultar el sistema usa
> [`../src/modules/alertas/decision-v2/README.md`](../src/modules/alertas/decision-v2/README.md).

Copia desde el siguiente bloque en una nueva sesión de Codex.

---

Trabaja en el workspace `C:\dev\ruralicos`, concretamente en el repositorio independiente `C:\dev\ruralicos\ruralicos-api`.

Quiero reconstruir el núcleo de clasificación y decisión de los digests como `decision-v2`. El nuevo motor debe construirse en paralelo y ejecutarse inicialmente en sombra. El sistema actual seguirá siendo el único que crea y envía digests hasta que los resultados reales demuestren que v2 funciona mejor.

Antes de hacer cambios:

1. Lee `C:\dev\ruralicos\AGENTS.md` y `C:\dev\ruralicos\ruralicos-api\AGENTS.md`.
2. Lee completo `docs/DECISION_V2_ARCHITECTURE.md`. Es la fuente de verdad de esta reconstrucción.
3. Usa la skill `ruralicos-workspace` y, si hay migraciones o consultas Supabase, las skills `ruralicos-supabase` y `supabase`.
4. Para entender relaciones de código empieza con Graphify. Después usa `rg` por símbolo y abre sólo fragmentos relevantes; no cargues completos los archivos grandes prohibidos por `AGENTS.md`.
5. Comprueba `git status`, rama actual y cambios ajenos. No mezcles repositorios ni sobrescribas trabajo no relacionado.

## Objetivo

Implementar por completo un motor nuevo con una arquitectura deliberadamente simple:

```text
alertas oficiales + perfil del usuario
  -> filtros objetivos
  -> una decisión LLM conjunta por usuario
  -> validación técnica
  -> persistencia de la decisión en sombra
```

El LLM será la única autoridad semántica. No crees otro selector, score, juez, segunda opinión, reconciliación, `HOLD` o validador semántico posterior.

No quiero una prueba de concepto, un esqueleto ni una primera entrega parcial. Construye todo el recorrido de v2 en sombra: carga real de alertas y perfiles, filtros, decisión conjunta, contrato, persistencia, generación completa de digests y mensajes simulados, runner diario, comparación con el sistema actual, corpus de regresión, pruebas y documentación operativa. Sólo debe quedar fuera la conexión con la entrega real.

## Límites obligatorios

- No reconstruyas scrapers, normalización, perfiles, deduplicación, composición del digest, outbox ni WhatsApp.
- Conserva los tres niveles de deduplicación: publicación, usuario-alerta y outbox.
- No modifiques ni integres MIA. MIA se reconstruirá más adelante en una fase independiente.
- No intentes mejorar ahora la redacción de los mensajes.
- No elimines todavía el motor actual.
- No envíes WhatsApp, no ejecutes scrapers reales contra producción y no hagas backfills.
- Mientras esté en sombra, v2 no puede escribir en las tablas de producción `digests` ni `digest_items`, ni crear outbox o logs de proveedor. Sí debe crear digests completos en las tablas de sombra.
- No optimices coste, tokens o latencia antes de validar la calidad de decisión.
- No añadas capas para problemas hipotéticos. Completa todo el alcance acordado manteniendo una única autoridad semántica y el menor número razonable de piezas.

## Comportamiento requerido

### Universo de alertas

V2 debe poder evaluar todas las alertas válidamente ingeridas del periodo. No debe depender de `estado_ia="listo"` ni heredar como barrera los descartes semánticos del clasificador actual.

Los estados actuales pueden incluirse como metadatos para comparar, pero no deben impedir que el LLM vea la alerta.

### Filtros previos permitidos

Sólo aplica barreras objetivas:

- Fuente o documento oficial ausente o inválido.
- Territorio oficialmente incompatible.
- Publicación duplicada.
- Alerta ya enviada a ese usuario.
- Preferencia explícita cuya correspondencia sea inequívoca.
- Exclusión de producto inequívoca y respaldada.

No uses como barreras:

- Sector o actividad inferidos.
- Resumen generado.
- Taxonomía rural/no rural.
- Score, embedding o similitud.
- Confianza del clasificador anterior.
- Beneficiarios, acción o plazo no detectados.
- Plazo vencido por sí solo.

### Decisión LLM

Haz una decisión conjunta por usuario. El modelo debe recibir el perfil completo y todas las candidatas compatibles, con contenido o fragmentos oficiales suficientes para no depender de etiquetas generadas.

Debe devolver todas las candidatas exactamente una vez como `include` o `exclude`. Para las incluidas debe devolver prioridad, motivo y evidencia. Para las excluidas debe devolver motivo y evidencia.

La política debe favorecer cobertura cuando existe relación rural plausible y respaldada, pero no convertir ausencia de evidencia rural en inclusión automática.

### Validación

Valida únicamente el contrato técnico:

- JSON válido y versión reconocida.
- Usuario correcto.
- IDs pertenecientes a la entrada.
- Todas las candidatas aparecen exactamente una vez.
- Sin duplicados.
- Máximo de incluidos respetado.
- Motivos y evidencias presentes.
- URL y territorio válidos en las inclusiones.

Permite un único reintento destinado a corregir formato. Si falla otra vez, registra error y no fabriques una decisión alternativa.

### Auditoría

Persiste de forma reproducible:

- Ejecución, fecha y usuario.
- Modelo y versión del prompt.
- Snapshot o referencia estable del perfil.
- Todas las candidatas y exclusiones objetivas.
- Respuesta bruta segura.
- Decisión normalizada por alerta.
- Motivos y evidencias.
- Tokens, duración y errores.
- Digest simulado completo y mensaje que se habría enviado.
- Items seleccionados y su orden final.

Mantén la posibilidad futura de trazar:

```text
alerta -> decisión -> digest_item -> digest -> outbox/log
```

Durante la sombra la traza termina en `shadow_digest_runs` y `shadow_digest_items`; no conectes v2 con la entrega.

### Persistencia aislada de sombra

No reutilices `digests` o `digest_items` añadiendo `is_shadow`. Crea mediante migración aditiva tres tablas internas y completamente separadas:

- `shadow_digest_runs`.
- `shadow_candidate_decisions`.
- `shadow_digest_items`.

`shadow_digest_runs` guarda la ejecución completa y el digest simulado, incluido `mensaje_preview`. `shadow_candidate_decisions` guarda una fila por candidata. `shadow_digest_items` guarda las incluidas en su orden final. Todo este histórico es temporal y exclusivo de la evaluación.

Usa claves estables y explícitas para unir las tablas de sombra durante la evaluación: `shadow_run_id`, `workflow_date`, `user_id`, `organization_id` cuando proceda, `alert_id`, versiones del motor/prompt/render y posiciones de entrada y salida.

No diseñes una copia, renombrado o migración del histórico de sombra. La integración final se hará por contrato de código: el mismo `decisionEngine` devolverá la selección y un adaptador de producción la entregará al creador existente de `digests` y `digest_items`.

Habilita RLS y revoca acceso a `public`, `anon` y `authenticated`, siguiendo los patrones internos existentes. No añadas relaciones, triggers ni campos que puedan encolar o entregar esos digests. No generes enlaces de tracking reales, clicks, outbox, teléfonos ni logs de proveedor.

El mensaje de sombra debe reutilizar el compositor actual o una función pura extraída de él, sin efectos laterales. Debe poder compararse visualmente con el mensaje de producción del mismo usuario y fecha.

### Evaluación en otra sesión

No implementes un exportador, dashboard, comparador ni evaluador automático. Guarda en las tres tablas toda la información necesaria para que el usuario y otra sesión puedan consultarla directamente mediante Supabase: perfil, candidatas, evidencia, entrada y salida del LLM, decisiones, items y mensaje completo. No anonimices ni transformes esos datos. No crees una ruta pública y no llames a otro LLM desde el backend.

## Casos reales que deben convertirse en pruebas

Incluye como corpus de regresión:

1. Subvenciones aragonesas para servicios de juventud: excluir si no existe relación rural real, aunque un resumen derivado diga agricultura o ganadería.
2. Subvención a clubes para carreras de montaña: excluir si la actividad es deportiva y no agraria.
3. Pesca o acuicultura no agraria: evitar que `pac` dentro de `impacto` cuente como evidencia PAC.
4. Seguros agrarios: incluir para perfiles y territorios compatibles.
5. Producción integrada del olivar: incluir para perfiles compatibles.
6. DOP Sidra de Asturias: no descartarla como actividad cultural.
7. Gestión del conejo silvestre: reconocer su relación agraria cuando esté respaldada.
8. Mantener las garantías territoriales y de no duplicación existentes.

No uses datos personales reales en fixtures, logs o respuestas.

## Forma de trabajo esperada

1. Reconstruye primero el punto exacto donde están disponibles alertas ingeridas, perfiles e historial, y el punto donde hoy comienza la preparación del digest.
2. Presenta un mapa breve de símbolos, tablas y riesgos antes de editar.
3. Propón un plan por fases para construir el sistema completo y ejecútalo de extremo a extremo en la misma tarea. No te detengas en un esqueleto o una primera entrega vertical salvo que exista un bloqueo material real.
4. Si hace falta persistencia nueva, escribe una migración aditiva siguiendo las instrucciones de Supabase. No cambies producción.
5. Implementa v2 en una carpeta aislada, preferiblemente:

   ```text
   src/modules/alertas/decision-v2/
     decisionEngine.js
     decisionRepository.js
     README.md
   ```

   No multipliques archivos si no existe una frontera clara.

6. Añade una forma explícita de ejecutar v2 en sombra. Debe generar y persistir `shadow_digest_runs` y `shadow_digest_items`, pero ser imposible que esa ruta llame al envío real.
7. Añade pruebas unitarias del contrato y filtros, una prueba contractual del corpus observado con `callLLM` simulado y una prueba de integración que demuestre que la sombra crea el digest simulado sin escribir `digests`, `digest_items`, tracking, outbox o logs de proveedor. La clasificación del LLM real se validará ejecutando la sombra.
8. Ejecuta primero pruebas dirigidas; después `npm run check:core` y las validaciones amplias que correspondan.
9. Ejecuta `graphify update .` después de los cambios.
10. Entrega al usuario un resumen en español: qué se construyó, qué se conservó, qué queda pendiente, riesgos y pruebas ejecutadas.

## Entrega completa esperada

La reconstrucción en sombra no se considera terminada hasta que existan:

1. Motor de decisión v2 completo con una decisión conjunta por usuario.
2. Filtros objetivos y contrato de salida versionado.
3. Persistencia reproducible y aislada en `shadow_digest_runs`, `shadow_candidate_decisions` y `shadow_digest_items`.
4. Generación completa de items y `mensaje_preview`.
5. Runner integrado en el workflow diario en modo sombra y sin capacidad de envío.
6. Mecanismo sencillo para comparar v2 con las selecciones, items y mensajes reales del motor vigente.
7. Corpus de regresión con los errores reales conocidos.
8. Pruebas unitarias, de integración, de territorio, deduplicación, generación del mensaje y ausencia de efectos de entrega.
9. Documentación para ejecutar, consultar y diagnosticar la sombra.
10. Validaciones amplias del repositorio y Graphify actualizado.

Después habrá que ejecutar v2 sobre datos reales, revisar sus resultados y ajustar únicamente lo que la evidencia muestre. No conectes v2 con producción ni retires el motor anterior hasta que el usuario apruebe expresamente la sustitución.

## Criterios de diseño

- Una sola autoridad semántica.
- El contenido oficial prevalece sobre datos derivados.
- Una alerta no desaparece antes del decisor salvo por una barrera objetiva.
- Incertidumbre semántica no equivale automáticamente a inclusión.
- Fallo técnico no equivale a selección alternativa.
- La auditoría registra decisiones; no las modifica.
- La entrega sigue siendo idempotente.
- La arquitectura debe poder explicarse como: cargar, filtrar, decidir, validar formato y guardar.

## Primera respuesta esperada de la sesión

No empieces reescribiendo módulos grandes. Primero confirma que has leído la arquitectura, identifica con Graphify y `rg` los puntos concretos de integración, inspecciona el esquema mediante migraciones y presenta el plan completo. Después continúa con toda la implementación en sombra si no aparece un bloqueo material; no pares tras el scaffolding o una demostración parcial.

---
