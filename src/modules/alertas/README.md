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
| `revisarAlertas.routes.js` | Revisión final de alertas procesadas |
| `deduplicar.routes.js` | Agrupa equivalencias y evita alertas repetidas |
| `alertasFree.routes.js` | Resumen limitado para plan gratuito |
| `alertas.service.js` | Operaciones compartidas de persistencia/proceso |

Las rutas automáticas están protegidas para admin o cron según su efecto. `GET` no implica que sea público: varias rutas históricas admiten GET y POST, pero ambas deben validar el token.

## Tres capas internas

### [`clasificacion/`](clasificacion/)

Preclasifica, aplica exclusiones justificadas y protege evidencia rural/oficial.

### [`intelligence/`](intelligence/)

Construye la ficha de hechos, valida soporte documental, relaciona documentos y aplica doble comprobación cuando el riesgo es alto.

### [`seleccion/`](seleccion/)

Compara alerta y usuario, aplica barreras duras, puntúa, diversifica y registra por qué entra o sale.

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
```

Añade siempre un caso positivo y su contraparte negativa, especialmente para provincia, sector, expedientes individuales y descarte.
