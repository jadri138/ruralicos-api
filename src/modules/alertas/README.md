# Alertas

Núcleo de inteligencia del sistema. Convierte entradas de boletines en alertas utilizables y decide si cada alerta puede llegar a una persona concreta.

## Flujo de una alerta

```text
insertada
  → pendiente_clasificar
  → pendiente_resumir
  → pendiente_revisar
  → lista para selección
  → candidata, incluida o excluida del digest
```

Estados retenidos:

- `pendiente_revision_manual`: la automatización no tiene seguridad suficiente.
- `needs_evidence`: falta respaldo documental; no debe continuar como alerta fiable.

`alertPipelineStates.js` distingue pendientes automáticos de retenidos para que una reparación no fuerce a avanzar algo que necesita evidencia.

## Archivos HTTP

| Archivo | Responsabilidad |
| --- | --- |
| `alertas.routes.js` | CRUD controlado, clasificación, resumen, revisión y estado del pipeline |
| `deduplicar.routes.js` | Agrupa equivalencias y evita alertas repetidas |
| `alertasFree.routes.js` | Resumen limitado para plan gratuito |
| `alertas.service.js` | Operaciones compartidas de persistencia/proceso |

Las rutas automáticas están protegidas para admin o cron según su efecto. Las
consultas usan `GET`; las operaciones que modifican datos usan `POST`.

## Capas internas

### [`clasificacion/`](clasificacion/)

Preclasifica, aplica exclusiones justificadas y protege evidencia rural/oficial.

### [`intelligence/`](intelligence/)

Construye la ficha de hechos, valida soporte documental, relaciona documentos y aplica doble comprobación cuando el riesgo es alto.

### [`seleccion/`](seleccion/)

Compara alerta y usuario, aplica barreras duras, puntúa, diversifica y registra por qué entra o sale.

### [`decision/`](decision/)

Adapta la ficha y el perfil a contratos versionados, une candidatas exactas,
semánticas, de memoria, cobertura y exploración, reduce a un top K y ejecuta el
juez personal. `authority.js` vuelve a aplicar barreras, idempotencia,
frecuencia, repetición y portfolio antes de permitir un mensaje.

Estados canónicos: `SEND_NOW`, `ADD_TO_DIGEST`, `HOLD_FOR_EVIDENCE`, `DROP` y
`BLOCKED`. Un bloqueo territorial o una falta de evidencia no se compensa con
score. `HOLD_FOR_EVIDENCE` solo relee material ya guardado; no llama a scrapers.

El replay de esta capa usa `decision/replay.js` y
`decision/historicalSequence.js`: reproduce cada día de una ventana, aplica
feedback/clics solo a días posteriores y compara decisión y mensaje sin enviar
nada. `decision/replaySnapshotExporter.js` puede construir un corpus local
seudonimizado leyendo Supabase sin mutarlo. El grader semántico de
`decision/replayGrader.js` es opcional, inyectable y nunca decide la aceptación.

### [`decision-v2/`](decision-v2/)

Motor nuevo y aislado en sombra. Parte de todas las alertas ingeridas del día,
aplica únicamente filtros objetivos y realiza una decisión LLM conjunta por
usuario. Persiste perfil, candidatas, contrato, respuestas, decisiones, items y
mensaje completo en tres tablas `shadow_*`; no alcanza ninguna ruta de entrega.
Su [README](decision-v2/README.md) documenta activación, ejecución y consultas.

## Cómo se filtra

Orden conceptual:

1. **Integridad:** estado, título, URL, resumen y calidad mínima.
2. **Bloqueos críticos:** duplicada, descartada, individual sin interés general, contenido no agrario, licitación/nombramiento irrelevante, evidencia insuficiente, etc.
3. **Territorio:** coincide la provincia/ámbito o la alerta es realmente nacional.
4. **Sector y subsector:** compatibilidad declarada o inferida de forma segura.
5. **Tipo de alerta:** preferencias activas del usuario.
6. **Exclusiones personales:** preferencias explícitas que deben respetarse.
7. **Valor operativo:** plazo, solicitud, subsanación, obligación, ayuda, recurso u otra acción útil.
8. **Calidad y riesgo de ruido:** la calidad puede bloquear o mandar a revisión segura.
9. **Ranking:** prioridad, afinidad y señales aprendidas.
10. **Diversidad:** límites por fuente, tipo y anuncios individuales.

Una señal aprendida puede mejorar el orden, pero no anula geografía, seguridad, exclusiones explícitas ni evidencia.

## Resumen FREE

`alertasFree.routes.js` no resume todas las alertas listas. Antes de llamar a la
IA exige sector rural demostrado e impacto práctico (ayuda, plazo, sanidad,
obligación, emergencia o regadío), descarta ruido administrativo, elimina URLs
duplicadas, diversifica fuentes y limita la entrada a ocho avisos. La salida
solo puede usar las URLs recibidas y nombra su fuente real (BOE, boletín
autonómico o provincial). Si la IA falla o rompe el contrato, se genera un
mensaje local seguro; un resumen antiguo con formato o candidatos no válidos no
se envía.

## Política de selección

`alertSelectionEngine.js` mantiene la política por defecto: umbrales de inclusión/revisión, calidad mínima, objetivo y máximo de elementos, diversidad por fuente/tipo y límite de anuncios individuales. El resultado incluye:

- acción (`include`, `review` o `exclude`);
- puntuación;
- motivo;
- señales detectadas;
- coincidencias declaradas;
- riesgo;
- trazabilidad territorial/sectorial/tipo.

Los casos `review_only` solo pueden rellenar el digest si son seguros, no tienen bloqueos y alcanzan umbrales superiores de calidad.

## Auditoría

- Los descartes estructurados conservan código y evidencia.
- `audienceReach` guarda el alcance estimado en el momento de la decisión.
- `digest_candidate_decisions` permite reconstruir el paso de una candidata.
- El panel ofrece `preview-audience`, “por qué se envió” y “por qué no se envió”.

## Pruebas mínimas al cambiar filtros

```powershell
node tests\alertaMatcher.test.js
node tests\alertSelectionEngine.test.js
node tests\alertSelectionGate.test.js
node tests\audienceReach.test.js
node tests\auditedFalseDiscardCorpus.test.js
node tests\finalValidationAuthority.test.js
node tests\alertDecisionCore.test.js
node tests\digestDecisionIntegration.test.js
node tests\decisionEvidenceRecovery.test.js
node tests\alertDecisionReplay.test.js
node tests\alertDecisionHistoricalReplay.test.js
```

Añade siempre un caso positivo y su contraparte negativa, especialmente para provincia, sector, expedientes individuales y descarte.
