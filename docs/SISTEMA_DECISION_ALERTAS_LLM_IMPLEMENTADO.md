# Sistema de decisión de alertas LLM implementado

> Estado del repositorio: implementado y probado en local.
>
> Estado operativo: requiere despliegue coordinado. La migración
> [`20260801211224_alert_decision_delivery_contracts.sql`](../supabase/migrations/20260801211224_alert_decision_delivery_contracts.sql)
> no se ha aplicado a producción durante este trabajo y no se ha comprobado la
> configuración de ACK de la instancia real de UltraMsg.
>
> Fecha de esta documentación: 1 de agosto de 2026.

Este documento describe el resultado de implementar el
[`BLUEPRINT_SISTEMA_DECISION_ALERTAS_LLM.md`](BLUEPRINT_SISTEMA_DECISION_ALERTAS_LLM.md).
El sistema empieza cuando la alerta ya existe. No cambia scrapers, fuentes,
captura de documentos ni nada bajo `src/modules/boletines/`.

## Resultado en una frase

Una sola cadena toma alertas existentes, conserva únicamente hechos con
evidencia, aplica barreras duras, valora un top pequeño para cada persona,
autoriza el mensaje de forma determinista, lo encola una sola vez y distingue
entre aceptación del proveedor y entrega real al teléfono.

## Paquete 0: auditoría de realidad

La auditoría se hizo contra código, tests, migraciones y el esquema remoto en
modo solo lectura. La columna «estado inicial» usa las cuatro categorías pedidas
por el blueprint; la última columna indica qué quedó en este repositorio.

| Garantía | Estado inicial | Evidencia encontrada | Resultado en el repositorio |
| --- | --- | --- | --- |
| Un único workflow diario | Existe | `scripts/run_digest_workflow.js` | Se conserva y ahora prepara, encola, drena la única outbox y concilia |
| Ficha de hechos y evidencia | Parcial | `alert_fact_sheets` y `alertas/intelligence/` | Adaptador canónico, validación por campo y recuperación acotada sobre material ya almacenado |
| Barreras de territorio, actividad y evidencia | Existe | matcher, selección y validador final | Se reutilizan como veto; ninguna puntuación ni LLM puede saltarlas |
| Varias vías de candidatas y ranking | Parcial | selección exacta, embeddings, perfil y exploración separados | Unión deduplicada con origen conservado, ranking determinista y top K |
| Juez personal usuario-alerta | Falta | No había una autoridad contractual aislada | Juez con JSON Schema estricto, abstención segura y segunda opinión selectiva |
| Autoridad final y portfolio | Parcial | validador final y límites dispersos | Autoridad única para idempotencia, frecuencia, repetición, diversidad y hechos del mensaje |
| Mensaje derivado solo de hechos aprobados | Parcial | generador y validador final | Proyección de hechos permitidos y render determinista con URL oficial |
| Cola única de comunicaciones | Parcial | `mia_outbox` y ruta digest con dos modos | Digest, FREE y exploración usan la misma outbox; se retira el modo síncrono del digest |
| ACK real y conciliación | Falta | HTTP aceptado se trataba como enviado | Máquina de estados, ID de proveedor, webhook idempotente y conciliación; pendientes de migración y configuración externas |
| Memoria atómica | Parcial | `user_memory` y `mia_structured_memory` duplicaban conceptos | `user_memory` es canónica; el adaptador histórico escribe ahí y `mia_structured_memory` queda solo para lectura/borrado |
| Replay offline previo a producción | Falta | Replay de MIA, no del sistema usuario-alerta completo | Corpus dorado, pruebas metamórficas y replay local sin base de datos ni transporte |
| Bloqueo global por una alerta pendiente | Retirar | Un pendiente de IA podía frenar a todos | Retirado; cada candidata falla, se retiene o continúa de forma aislada |
| Envíos automáticos directos y fases duplicadas | Retirar | Digest síncrono y exploración fuera del controlador | Digest, FREE, exploración y respuestas MIA no transaccionales usan la misma outbox; los mensajes de registro, acceso y administración quedan fuera de este blueprint |
| `DIGEST_VIA_OUTBOX` | Retirar | Interruptor entre dos transportes | Retirado; la cola ya no es opcional |

### Cifras observadas

Snapshot remoto de solo lectura tomado el 1 de agosto de 2026. Son cifras de la
auditoría, no telemetría en tiempo real ni prueba de que la nueva migración esté
aplicada.

| Objeto | Filas observadas |
| --- | ---: |
| `users` | 81 |
| `alertas` | 14.929 |
| `alert_fact_sheets` | 324 |
| `digest_attempts` | 2.483 |
| `digest_candidate_decisions` | 395.358 |
| `digests` | 2.586 |
| `digest_items` | 2.198 |
| `whatsapp_logs` | 2.450 |
| `mia_outbox` | 8 |
| `user_interest_profile` | 391 |
| `user_memory` | 272 |

La diferencia entre alertas y fichas muestra que existe mucho histórico
anterior al contrato nuevo. La compatibilidad transforma esos registros de
forma conservadora; no rellena hechos que no estén respaldados.

## Arquitectura efectiva

```text
ALERTA YA CREADA + MATERIAL YA ALMACENADO
  -> ficha de hechos canónica
  -> barreras duras
  -> candidatas exactas / semánticas / memoria / cobertura / exploración
  -> ranking determinista y top K
  -> juez personal LLM con salida estricta
  -> segunda opinión solo en casos de riesgo
  -> autoridad final y portfolio
  -> texto derivado de hechos permitidos
  -> validación final determinista
  -> mia_outbox con idempotencia
  -> UltraMsg: aceptación, ACK y conciliación
  -> memoria atómica y métricas
```

Responsables principales:

| Capa | Implementación |
| --- | --- |
| Contratos y estados | [`src/modules/alertas/decision/contracts.js`](../src/modules/alertas/decision/contracts.js) |
| Ficha canónica | [`truthCard.js`](../src/modules/alertas/decision/truthCard.js) |
| Perfil pseudonimizado | [`decisionProfile.js`](../src/modules/alertas/decision/decisionProfile.js) |
| Candidatas y ranking | [`candidatePipeline.js`](../src/modules/alertas/decision/candidatePipeline.js) |
| Juez personal | [`judge.js`](../src/modules/alertas/decision/judge.js) |
| Autoridad y portfolio | [`authority.js`](../src/modules/alertas/decision/authority.js) |
| Recuperación de evidencia | [`holdRecovery.js`](../src/modules/alertas/decision/holdRecovery.js) y [`decisionEvidenceRecovery.js`](../src/modules/digest/decisionEvidenceRecovery.js) |
| Mensaje seguro | [`messageProjection.js`](../src/modules/alertas/decision/messageProjection.js) y [`decisionMessage.js`](../src/modules/digest/decisionMessage.js) |
| Integración con digest | [`decisionIntegration.js`](../src/modules/digest/decisionIntegration.js) |
| Entrega y ACK | [`src/modules/delivery/`](../src/modules/delivery/) |
| Memoria atómica | [`atomicMemory.js`](../src/modules/aprendizaje/atomicMemory.js) |
| Replay | [`replay.js`](../src/modules/alertas/decision/replay.js), [`historicalSequence.js`](../src/modules/alertas/decision/historicalSequence.js) y [`scripts/replay_alert_decisions.js`](../scripts/replay_alert_decisions.js) |
| Snapshots históricos | [`replaySnapshotExporter.js`](../src/modules/alertas/decision/replaySnapshotExporter.js) |
| Grader auxiliar | [`replayGrader.js`](../src/modules/alertas/decision/replayGrader.js) |

## Contratos versionados

| Contrato | Versión |
| --- | --- |
| Ficha de alerta | `alert_truth_card_v1` |
| Perfil de decisión | `user_decision_profile_v1` |
| Candidata | `alert_candidate_v1` |
| Decisión usuario-alerta | `alert_user_decision_v1` |
| Política | `alert_decision_policy_v1` |
| Portfolio | `alert_portfolio_v1` |
| Recuperación de evidencia | `hold_recovery_v1` |
| Hechos del mensaje | `message_facts_v1` |
| Entrega | `delivery_state_v1` |
| Juez / prompt | `personal_relevance_judge_v2` / `personal_relevance_prompt_v1` |
| Memoria | `atomic-memory-v1` |

Cada decisión conserva estado, versiones, `reason_codes`, huella de entrada y
momento de decisión. La lista de `reason_codes` es cerrada: una explicación
libre no sustituye el motivo estructurado.

### Estados de decisión

| Estado | Uso |
| --- | --- |
| `SEND_NOW` | Urgencia excepcional con acción, plazo y evidencia suficientes |
| `ADD_TO_DIGEST` | Apta para el próximo digest |
| `HOLD_FOR_EVIDENCE` | Falta un dato esencial; se intenta recuperar sobre material ya guardado |
| `DROP` | No aporta utilidad suficiente, está repetida o supera límites de portfolio |
| `BLOCKED` | Incumple una barrera dura y no puede ser rescatada por score o LLM |

`SEND_NOW` no crea un transporte paralelo. Toda comunicación automática pasa
por el mismo controlador y la misma outbox.

### Autoridad y límites

- Territorio, exclusiones, vigencia y evidencia siguen siendo barreras.
- Los embeddings solo recuperan candidatas.
- El juez recibe un perfil mínimo pseudonimizado, no teléfono, secretos ni el
  texto libre de las conversaciones. De la memoria solo ve ámbito, clave
  estructurada, fuerza y autoridad.
- El juez no puede crear beneficiarios, territorio, plazos, importes o URLs.
- Una salida inválida, contradicción o dato esencial ausente cae a un estado
  seguro; el fallo de una candidata no bloquea a los demás usuarios.
- La segunda opinión se usa solo cuando el riesgo lo justifica.
- El portfolio limita duplicados, frecuencia, exploración y diversidad.
- No se añade contenido para llenar una cuota.
- El mensaje usa exclusivamente la proyección de hechos aprobados y siempre
  conserva el enlace oficial.

## Evidencia incompleta

`HOLD_FOR_EVIDENCE` activa una recuperación limitada. Solo relee y reconcilia
el contenido, resumen, documento o ficha que Ruralicos ya almacenó. No ejecuta
scrapers ni busca una fuente nueva.

El estado, número de intentos, siguiente intento, estrategia y campos ausentes
se guardan en `alert_fact_sheets`. Si aparece evidencia suficiente, la candidata
se reevalúa. Si se agotan las estrategias o vence, termina con motivo auditable.

Un `HOLD` del juez por un fallo transitorio (proveedor no disponible,
presupuesto, JSON inválido, abstención o desacuerdo) usa otro ciclo, guardado en
`digest_candidate_decisions`. La preparación diaria reclama como máximo un cupo
por persona, recupera leases abandonados y reevalúa con backoff. Tras el último
intento queda `EXHAUSTED` y se convierte en silencio seguro; nunca genera un
segundo pipeline ni un mensaje por su cuenta.

`POST /tareas/hold-evidence-recovery`, protegido por `CRON_TOKEN`, procesa solo
filas `PENDING` o `FAILED` cuyo siguiente intento ya venció. Reclama cada fila
como `PROCESSING`, recupera trabajos atascados y aplica backoff. El workflow lo
ejecuta antes de preparar los digests; no existe otro cron ni descarga material.

## Memoria y aprendizaje

La fuente canónica es `user_memory`, con clave idempotente, ámbito, polaridad,
origen, fuerza, confianza, vigencia, correcciones y contador de duplicados.

Jerarquía práctica:

```text
respuesta explícita > preferencia editada > acción fuerte > clic > lectura > silencio
```

Un clic es débil. Un fallo de transporte no aprende nada. Un rechazo mantiene
su ámbito: por ejemplo, «ya la pedí, pero similares sí» produce una memoria para
esa alerta y otra señal positiva para el tema, no una exclusión global.

`mia_structured_memory` se conserva temporalmente para lectura histórica y
borrado de privacidad, pero las escrituras nuevas pasan por el adaptador a
`user_memory`.

Las preguntas de aprendizaje no se añaden a todos los digest. La fase
`/cerebro/exploracion-diaria` solo elige usuarios con una incertidumbre útil y
un digest confirmado como `DELIVERED` o `READ` dentro de los últimos 7 días.
Así, un ACK que llega después del workflow del día sigue siendo aprovechable,
pero el mismo digest nunca genera dos preguntas. Por defecto limita a 20
preguntas globales al día y deja 30 días de espera por persona. La pregunta se
encola y su conversación de aprendizaje solo se abre tras una entrega real. Un
lease de 5 minutos permite terminar ese postproceso si el proceso se reinicia.

## Entrega real

```text
DRAFT -> APPROVED -> QUEUED -> PROVIDER_ACCEPTED
  -> SENT_TO_WHATSAPP -> DELIVERED -> READ
```

Los cierres de error son `FAILED` y `UNDELIVERED`. Los eventos repetidos son
idempotentes y uno antiguo no hace retroceder el estado.

| ACK UltraMsg | Estado Ruralicos |
| --- | --- |
| `pending` | `PROVIDER_ACCEPTED` |
| `server` | `SENT_TO_WHATSAPP` |
| `device` | `DELIVERED` |
| `read` / `played` | `READ` |
| `invalid` / `failed` | `FAILED` |
| `unsent` después de envío a WhatsApp | `UNDELIVERED` |

El HTTP correcto del endpoint de envío solo significa `PROVIDER_ACCEPTED`. En
el flujo nuevo, `digests.enviado=true` se sella únicamente con `DELIVERED` o
`READ`. Un `enviado=true` histórico solo evita duplicados; no se usa como prueba
de entrega ni como señal de aprendizaje.

### Webhook de ACK

URL prevista:

```text
POST https://<api-publica>/webhooks/ultramsg/feedback?token=<ULTRAMSG_WEBHOOK_TOKEN>
```

La misma ruta separa primero los ACK de entrega y después procesa mensajes
entrantes. En UltraMsg deben habilitarse `webhook_message_received` y
`webhook_message_ack`. Esta configuración externa no se realizó ni se verificó
en este trabajo.

El evento se correlaciona por `provider_message_id`. Solo se persiste un payload
sanitizado: teléfono, texto, identificadores sensibles y tokens se ocultan.

### Conciliación

`POST /tareas/whatsapp-reconcile` está protegido por `CRON_TOKEN`, acepta
`limit=1..100` y `dry_run=true`. Revisa elementos aceptados o enviados que
tienen ID de proveedor y evita reenviar a ciegas tras una respuesta ambigua.

El workflow diario ejecuta una conciliación al final. El endpoint también puede
usarse manualmente para diagnóstico, pero no debe convertirse en un segundo
pipeline programado.

## Migración de Supabase

La migración es aditiva y forward-only. Reutiliza tablas actuales y añade:

- contrato de decisión y embudo a `digest_candidate_decisions` y
  `digest_attempts`;
- idempotencia, versión del mensaje, estados, marcas de tiempo e ID del
  proveedor a `digests`, `mia_outbox` y `whatsapp_logs`;
- `whatsapp_delivery_events`, con RLS activado y acceso restringido al backend;
- contrato atómico e índices en `user_memory`;
- cola de recuperación en `alert_fact_sheets`;
- reserva atómica del límite diario del juez en
  `alert_decision_llm_daily_budget`, accesible solo por `service_role`;
- retención de decisiones, intentos y ACK durante 180 días para auditoría y
  replay, conservando también las alertas referenciadas durante esa ventana;
- borrado del outbox terminal a los 30 días para minimizar contenido operativo.

Los registros históricos que antes significaban «HTTP aceptado» se migran como
`PROVIDER_ACCEPTED`, nunca como `DELIVERED`.

### Despliegue coordinado

1. Detener temporalmente el único cron diario.
2. Confirmar proyecto Supabase, copia de seguridad y ejecutar
   `supabase migration list --linked`. Comparar las dos columnas completas con
   `supabase/migrations/`: si el historial local y remoto no coincide, detenerse
   y reconciliarlo de forma coordinada antes de cualquier `db push`. No marcar
   migraciones como aplicadas ni reparar el historial por intuición.
3. Probar la migración en una base local limpia o entorno de staging.
4. Aplicar la migración al proyecto correcto.
5. Desplegar la API de esta misma versión.
6. Configurar y verificar el webhook de UltraMsg con un entorno controlado.
7. Ejecutar replay y comprobaciones de esquema; después hacer un dry-run de
   outbox/conciliación sin mensajes reales.
8. Reactivar un solo cron con el comando diario y vigilar el primer ciclo.

No se debe desplegar la API nueva antes de que existan sus columnas, ni aplicar
la migración y dejar durante horas una API antigua escribiendo semántica legacy.

### Rollback seguro

Ante un fallo, detener el cron y volver primero a la versión anterior de la API.
Las columnas y tablas añadidas pueden quedarse: son compatibles y conservarlas
evita perder trazas. No borrar datos ni columnas durante una incidencia.

Si después se decide retirar el esquema, crear otra migración revisada, tras
exportar auditoría y comprobar dependencias. La migración implementada no tiene
un rollback destructivo automático.

## Variables de entorno

La lista completa está en [`.env.example`](../.env.example). Variables nuevas o
relevantes:

| Variable | Predeterminado | Uso |
| --- | ---: | --- |
| `ALERT_DECISION_TOP_K` | `10` | Candidatas máximas enviadas al juez; el código limita entre 1 y 20 |
| `ALERT_DECISION_JUDGE_MODEL` | `gpt-5-nano` | Modelo del juez principal |
| `ALERT_DECISION_SECOND_OPINION_MODEL` | modelo principal | Modelo de segunda opinión selectiva |
| `ALERT_DECISION_JUDGE_CONCURRENCY` | `3` | Evaluaciones simultáneas; el código limita entre 1 y 6 |
| `ALERT_DECISION_LLM_DAILY_CALL_LIMIT` | `0` | Tope diario de juez y segunda opinión; antes de producción debe configurarse un valor positivo medido. Si no puede comprobarse el uso de un tope activo, no hace llamadas |
| `ALERT_DECISION_JUDGE_PRICING_JSON` | sin valor | Tarifas explícitas por modelo para calcular coste; sin ellas se guardan tokens y el coste queda `null`, nunca inventado |
| `ALERT_DECISION_PSEUDONYM_SALT` | fallback interno | Sal estable para pseudónimos; configurar un secreto largo y estable en producción |
| `ALERT_DECISION_MESSAGE_MAX_CHARS` | `3200` | Tamaño máximo del mensaje; límite efectivo 800..4096 |
| `OUTBOX_MAX_LOOPS` | `50` | Máximo de lotes que drena el workflow antes de fallar |
| `HOLD_RECOVERY_MAX_LOOPS` | `20` | Máximo de lotes `HOLD_FOR_EVIDENCE` que recupera el workflow diario |
| `ALERT_DECISION_HOLD_MAX_RETRIES` | `3` | Intentos máximos de un `HOLD` transitorio del juez antes de cerrarlo en silencio |
| `ALERT_DECISION_HOLD_RETRY_PER_USER` | `2` | Reintentos vencidos reclamados por persona y ejecución diaria |
| `ALERT_DECISION_HOLD_RETRY_BASE_HOURS` | `24` | Espera inicial; aumenta exponencialmente |
| `ALERT_DECISION_HOLD_RETRY_MAX_HOURS` | `96` | Tope del backoff |
| `ALERT_DECISION_HOLD_RETRY_LEASE_MS` | `900000` | Lease recuperable de una reevaluación en proceso |
| `RECOMMENDATION_VOLUME_BASELINE_DAYS` | `7` | Días históricos máximos usados para la mediana de volumen |
| `RECOMMENDATION_VOLUME_MIN_BASELINE_DAYS` | `5` | Muestra histórica mínima antes de generar un aviso |
| `RECOMMENDATION_VOLUME_MIN_BASELINE_VOLUME` | `5` | Mediana mínima para evitar alertas por volúmenes residuales |
| `RECOMMENDATION_VOLUME_DROP_RATIO` | `0.5` | Una caída hasta la mitad o menos se considera anómala |
| `RECOMMENDATION_VOLUME_SPIKE_RATIO` | `2` | Un volumen del doble o más se considera anómalo |
| `ULTRAMSG_RECONCILE_ACCEPTED_MS` | `600000` | Espera para conciliar un aceptado |
| `ULTRAMSG_RECONCILE_SENT_MS` | `1800000` | Espera para conciliar un enviado a WhatsApp |
| `ULTRAMSG_RECONCILE_TIMEOUT_MS` | `15000` | Timeout de consulta; el código limita a 60 segundos |
| `ULTRAMSG_WEBHOOK_TOKEN` | sin valor | Protege mensajes entrantes y ACK |
| `RUN_DAILY_EXPLORATION` | `true` | Activa la fase selectiva posterior a entrega dentro del mismo workflow |
| `MIA_MAX_PREGUNTAS_EXPLORACION_DIA` | `20` | Cupo global diario de preguntas |
| `MIA_EXPLORACION_COOLDOWN_DIAS` | `30` | Espera mínima por persona |
| `MIA_EXPLORACION_DIGEST_WINDOW_DIAS` | `7` | Ventana para admitir un ACK tardío del último digest |
| `MIA_LEARNING_POSTPROCESS_LEASE_MS` | `300000` | Lease recuperable del aprendizaje posterior al ACK |

`DIGEST_VIA_OUTBOX` ya no existe: mantenerlo produciría una falsa impresión de
que sigue habiendo dos transportes.

## Operación diaria

Producción debe ejecutar una sola vez al día:

```bash
node scripts/run_digest_workflow.js
```

Orden relevante después de que la alerta existe:

1. completar clasificación, resumen, revisión y deduplicación;
2. recuperar `HOLD_FOR_EVIDENCE` de datos vencidos usando solo material almacenado;
3. preparar el digest persona a persona, incluida la salida automática y
   acotada de `HOLD` transitorios del juez;
4. encolar digests de pago y resúmenes FREE;
5. drenar la única `mia_outbox` y conciliar estados con UltraMsg;
6. elegir preguntas solo para digest ya entregados o leídos y, si se encoló
   alguna, reutilizar el mismo drenador una segunda vez.

No programar `/tareas/pipeline-tick`, endpoints individuales, el drenador o la
conciliación como otro pipeline diario. Los endpoints de tareas son fases y
herramientas de diagnóstico.

## Replay histórico y offline

El corpus dorado tiene 16 casos e incluye relevancia clara, ruido, otra
provincia, ámbito autonómico y nacional, expediente individual, ayuda sin
plazo, obligación urgente, curso, evidencia incompleta, perfiles nuevos o
contradictorios y fallo de transporte sin aprendizaje. Los casos se recorren
como una secuencia diaria completa de varias semanas. Un feedback o clic queda
registrado al final de su fecha real y solo forma parte del perfil de los días
posteriores; los casos del mismo día comparten la instantánea inicial.

```powershell
npm run replay:alert-decisions
npm run replay:alert-decisions -- --json
npm run replay:alert-decisions -- --input .\ruta\corpus.json
```

Por defecto también ejecuta pruebas metamórficas: cambio de orden de campos,
retirada de evidencia y cambio territorial. El comando solo lee JSON local e
imprime resultados; no importa Supabase o WhatsApp, no escribe perfiles y no
envía mensajes. El informe compara decisión, presencia/contenido seguro del
mensaje, volumen, coste, territorio, estabilidad y memoria aplicada por día.

Para construir un corpus local desde datos históricos:

```powershell
npm run replay:export-snapshots -- --from 2026-07-01 --to 2026-07-31 --output .\tmp\replay-julio.json
npm run replay:alert-decisions -- --input .\tmp\replay-julio.json
```

El exportador consulta Supabase en modo de solo lectura. No selecciona
teléfonos, correos, nombres, texto libre de feedback, tokens, IP, contenido
completo de alertas ni mensajes. Los IDs se sustituyen con HMAC, los textos
estructurados pasan por redacción y el mensaje histórico se conserva solo como
presencia y huella. Crea un archivo local nuevo y se niega a sobrescribirlo.
`REPLAY_EXPORT_SALT` permite comparar exportaciones sin revelar IDs; si falta,
se usa una sal efímera que no se guarda. Como no existe historial versionado de
preferencias, cada snapshot marca las preferencias actuales seguras como
`current_safe_columns_proxy`; la fila de alerta lleva la misma marca. La ficha
y la memoria sí se cortan por la fecha reproducida, porque ambas conservan
fecha de creación.

Existe un grader LLM independiente como señal auxiliar. Está apagado por
defecto, nunca modifica `acceptance` y necesita activación y modelo explícitos:

```powershell
$env:REPLAY_GRADER_MODEL='<modelo-aprobado>'
npm run replay:alert-decisions -- --json > .\tmp\replay-report.json
npm run replay:grade -- --enable --input .\tmp\replay-report.json
```

Este último comando realiza una llamada a OpenAI, pero no envía WhatsApp ni
escribe en Supabase. Las pruebas siempre inyectan un grader simulado y bloquean
la red.

## Qué vigilar

- parejas evaluadas y distribución por estado/reason code;
- embudo `judge_evaluated → approved → queued → delivered`, reparto por
  `delivery_status` y caídas o picos contra la mediana histórica. Los avisos de
  volumen no se activan hasta reunir la muestra mínima configurada;
- tasa de `HOLD_FOR_EVIDENCE`, reparto de todo su ciclo y tasa de resolución;
  un `RESOLVED` que solo transfirió el caso a otro reintento no cuenta como
  solución efectiva;
- usuarios sin digest y causa cuantitativa;
- otra provincia enviada, hechos sin evidencia y duplicados: objetivo cero;
- llamadas lógicas, intentos reales al proveedor, reintentos, latencia, caché,
  fallbacks, tokens y coste por día, evaluación, usuario y digest aprobado. El endpoint protegido
  `/admin/mia/recommendation-health` los expone cuando se configuraron tarifas;
- tamaño y antigüedad de la outbox;
- aceptados, enviados a WhatsApp, entregados, leídos, fallidos y no entregados;
- tiempo entre estados y número de conciliaciones;
- decisiones sin versión, huella o reason code;
- crecimiento y conflictos de memoria atómica.

## Límites conocidos

- La cobertura histórica de fichas es baja; el adaptador protege el flujo, pero
  no convierte contenido viejo e incompleto en evidencia verificada.
- La migración necesita validación contra una base local/staging y aplicación
  coordinada; este trabajo no la aplicó a producción.
- La auditoría encontró diferencias entre el historial local y remoto de
  migraciones antiguas. Deben reconciliarse antes de ejecutar `db push`; no se
  modificó ese historial durante esta implementación.
- El ACK real depende de configurar UltraMsg y de conservar su
  `provider_message_id`; esa configuración externa no se verificó aquí.
- Coste y calibración del juez deben observarse con tráfico real. No hay cifras
  fiables previas con el contrato nuevo y el tope diario debe fijarse a un valor
  positivo antes de activar producción.
- `SEND_NOW` es excepcional y no autoriza un segundo canal ni un envío directo.
- Los scrapers y la captura de documentos quedan deliberadamente fuera de este
  sistema.

## Pruebas relacionadas

Las suites focalizadas están en `tests/alertDecisionCore.test.js`,
`tests/digestDecisionIntegration.test.js`, `tests/decisionEvidenceRecovery.test.js`,
`tests/digestDecisionMessage.test.js`, `tests/atomicMemory.test.js`,
`tests/whatsappDelivery.test.js`, `tests/alertDecisionReplay.test.js`,
`tests/alertDecisionHistoricalReplay.test.js` y
`tests/alertDecisionDeliveryMigration.test.js`, además de las pruebas de salud,
exploración y controlador único. Todas usan dobles locales; no deben realizar
un envío real.
