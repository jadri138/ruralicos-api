# Traspaso: por qué el digest dejó de enviarse y qué queda por hacer

Documento de arranque para una sesión nueva. Escrito el 8-08-2026 tras reparar la
parada de una semana. **Léelo entero antes de tocar el módulo de decisión**: casi
todo lo que parece un bug suelto aquí ya está investigado y medido.

---

## 1. Estado actual (8-08-2026)

- Rama de trabajo: `fix/api-recovery`.
- `origin/main` está en `fc0bb9b` (PR #46 fusionada y desplegada en Render).
- **Pendiente de fusionar**: `6867722` — el juez reparte ante la duda en vez de
  retener. Medido pero **todavía no desplegado ni validado en producción**.
- Producción no envía un digest desde el **1 de agosto**.

Comprobar siempre el commit desplegado antes de sacar conclusiones de un log:

```
GET https://ruralicos-api.onrender.com/health  →  checks.release.commit
```

Tres veces se diagnosticó sobre logs de código viejo porque el despliegue aún no
había terminado. No repitas ese error.

---

## 2. Qué pasó: el resumen corto

El **2 de agosto** entró de golpe el subsistema de decisión canónica
(`src/modules/alertas/decision/`, ~5.000 líneas: autoridad, juez LLM, ficha de
verdad, holds, portfolio) y se colocó por encima de un pipeline que llevaba meses
enviando bien. A partir de ahí: cero digests.

No fue un fallo, fueron seis encadenados. Todos corregidos y con prueba:

| Causa | Efecto | Commit |
| --- | --- | --- |
| La ficha escribe `"no_detectado"` cuando no extrae territorio, y la tarjeta lo leía como si fuera una provincia | Toda alerta estatal chocaba con el territorio de todos: 53 bloqueos en un día | `8cf450f` |
| La tarjeta no deducía el ámbito del boletín (BOE = estatal, BON = Navarra…) | Convocatorias sin provincia declarada se quedaban sin territorio | `8cf450f` |
| El cuerpo del bucle por usuario no tenía try/catch | Una excepción abortaba el lote entero: el 4-08 paró tras 19 usuarios | `fa81e68` |
| La auditoría se escribía antes de cerrar los HOLD reclamados y borraba el claim | `HOLD_RETRY_CLAIM_LOST` sin control | `fa81e68` |
| Las filas del lote no llevaban las mismas columnas (PostgREST manda NULL, no DEFAULT) | `null value in column "llm_calls"`: 24 usuarios sin auditoría | `fa81e68` |
| La barrera exigía territorio + beneficiarios + acción + URL verificados a la vez | 387 de 392 parejas retenidas por un dato que el mensaje ni afirma | `8c5c5a6` |

Y dos de infraestructura, ambas del mismo tipo — **código construido que nadie
llamaba**:

- `bopaEvidenceRecovery` solo se lanzaba a mano → 48 alertas atascadas en un día
  (`3266026`). Ya conectado, pero **recupera 0**: BOPA no sirve el texto.
- Las fichas solo se escribían *después* de enviar, así que eran consecuencia del
  envío y no entrada de la decisión. Círculo cerrado (`19a3e39`).

---

## 3. Decisiones de producto tomadas por el dueño

**No se deducen del código. No las cambies sin preguntar.**

1. **«Que lo que se envíe sea cierto y para ese cliente. Prefiero que reciba de
   más aunque no le interese tanto, pero no de menos. Siempre de su comunidad.»**
   Es la regla madre. Precisión por debajo de cobertura, salvo en territorio y
   veracidad.

2. **Un plazo pasado no silencia.** El boletín publica la resolución, la
   concesión, el listado de beneficiarios o el pago mucho después de cerrarse el
   plazo de solicitud: esa es la noticia que la persona espera. Retirado de la
   autoridad canónica **y** del validador de fichas — estaba en las dos capas y
   hubo que quitarlo dos veces.

3. **Beneficiarios y acción no bloquean.** El mensaje solo imprime lo que tiene
   evidencia; si faltan, la línea no aparece y lo enviado sigue siendo cierto.

4. **La IA debe decidir, no firmar.** Ver sección 5.

5. **No añadir módulos.** Preferencia explícita y repetida: simplificar y
   conectar lo que ya existe antes que escribir nada nuevo.

---

## 4. Invariantes que NO se tocan

- **Territorio**: nadie recibe nada fuera de su comunidad. Es una promesa, va en
  código determinista, nunca en un prompt.
- **Fuente oficial**: sin enlace verificable al boletín no se envía.
- **Solo hechos con evidencia**: `projectApprovedMessageFacts` filtra por
  `evidenceIsUsable`. Es lo que impide afirmar lo que no consta.
- **Expedientes y sanciones individuales no se difunden jamás.**
- **Una duda nunca se convierte en envío urgente** (`urgency: 0`).
- Contabilidad: no repetir lo ya enviado, horario tranquilo, frecuencia.

---

## 5. Lo que queda por hacer: que decida la IA

### El problema medido

El 7-08-2026, con 133 alertas listas:

```
selection                    668 alertas distintas   8.121 parejas
fact_sheet_preselection       27 alertas distintas     172 parejas
personal_relevance_judge      26 alertas distintas     167 parejas
```

**167 parejas entre 74 usuarios = 2,3 alertas por persona llegan al modelo.**

El motivo de exclusión dominante es `rescue_soft_not_selected`: 7.776 parejas.
Es decir, el scoring heurístico viejo elige las 2 o 3 finales y la IA solo puede
**vetarlas**. No elige: firma.

Y nunca firma: **856 decisiones del juez desde el 4-08, cero aprobaciones**. Los
2.601 digests que este producto ha enviado en su vida se hicieron sin él.

### El cambio

Una llamada al modelo **por persona**, con todas las candidatas que pasaron las
reglas duras: «este es el perfil, estas son las N alertas de su zona y su sector,
elige las que le sirven y explica por qué».

Aritmética, y es la razón de que esto sea más simple *y* más barato:

| | hoy | después |
| --- | --- | --- |
| Llamadas al modelo | 394/día | **79/día** |
| Alertas que ve cada persona | 2,3 | **~130** |

Subir los topes sin cambiar la forma daría 10.000 llamadas/día. Las dos cosas van
juntas: **una llamada por usuario, no por candidata**.

### Qué se borra

- La llamada por candidata: `mapWithConcurrency(judgePlans, …)` en
  `decision/index.js`
- La segunda opinión: `requiresSecondOpinion`, `reconcileOpinions`,
  `intersectFacts`
- La abstención y `deterministicFallback`
- El ciclo de vida de los HOLD: `digest/decisionHoldRetry.js`, sus columnas, su
  índice parcial y sus reintentos
- En `digest/digest.routes.js`: `topKCandidatas`, `maxCandidateUnion` y sobre
  todo `maxItems: maxAlertasUsuario` en `seleccionarAlertasParaDigest` — el tope
  del digest debe aplicarse al **resultado**, no a la entrada
- `ordenarPorAprendizaje` / `ordenarAlertasConPerfilOperativoMIA` como decisores

### Qué se queda

Las reglas duras de `candidatePipeline.evaluateCandidateEligibility`, la autoridad
(`authority.buildPortfolio`, idempotencia, horario, tope de 5) y la proyección del
mensaje.

### Qué se escribe

Una sola función: perfil + candidatas → selección con motivo. Reutiliza
`sanitizeUntrusted`, `projectTruthCardForJudge` y el contrato de `message_facts`
que ya existen. Balance estimado: ~200 líneas nuevas, más de mil fuera.

---

## 6. Cómo validar (esto es lo que funcionó)

**Medir sobre datos reales antes de escribir, y volver a medir después.** Sin
esto, dos de las reparaciones propuestas se habrían implementado y habrían
empeorado el producto.

Patrón: script temporal en la raíz del repo (para que resuelva `dotenv` y
`@supabase/supabase-js`), lectura con `SUPABASE_SERVICE_ROLE_KEY`, ejecutar la
función pura sobre alertas y usuarios reales, contar, y **borrar el script**.

Medidas conseguidas así:

- Barrera de evidencia: usuarios con alguna candidata elegible **5/79 → 79/79**.
- Fichas construidas antes de decidir: **40/40**, parejas elegibles 35 → 48.
- Juez que reparte ante la duda: **78 de 79 usuarios** recibirían digest, ~3,7
  alertas por persona y día, reparto por provincia siguiendo a la base real
  (Teruel 317, Huesca 294, Zaragoza 267).

**Propuestas que la medición tumbó** (no las repitas):

- *No fiarse de un descarte de baja confianza*: la confianza del clasificador no
  está calibrada — 794 alertas tienen exactamente 0,60 y la señal agraria aparece
  en todas las bandas. Un umbral de 0,7 retendría 1.595 alertas para pescar 76.
- *Usar el preclasificador como segunda opinión*: llama `strong_candidate` a 179
  de 843 descartadas, y al mirarlas son urbanismo, cultura y sanidad. No
  discrimina.

---

## 7. Trampas que ya han mordido

1. **`DIGEST_DECISION_VERSION` en `mia/digestAttempts.js` es manual.** Si cambias
   una barrera y no la subes, los `no_send` del día cuentan como firmes, el cron
   devuelve `usuarios_evaluados: 0` y parece que el despliegue no ha servido de
   nada. Pasó **dos veces en una noche**. Va por v12.

2. **La misma regla escrita en dos capas.** El filtro de plazo estaba en
   `candidatePipeline` y en `factSheetValidator`. Se quitó de una y el síntoma no
   cambió. *Si arreglas algo y el número no se mueve, la regla está duplicada.*

3. **PostgREST manda NULL, no DEFAULT**, en las columnas que falten en alguna
   fila de un lote. Todas las filas de un upsert deben traer el mismo juego de
   columnas: lo garantiza `uniformarFilasAuditoria`.

4. **Una pasada después de medianoche de Madrid** juzga a todo el mundo contra un
   día todavía sin alertas. Mitigado (`aff2b74`), pero tenlo presente al leer
   intentos con `total_alertas_dia: 0`.

5. **`ALERT_PRECLASSIFIER_MODE` vale `off` por defecto** y no está en Render:
   `pre_score` es NULL en las 15.025 alertas desde mayo. Capa entera inerte. No
   se encendió porque se midió que no discrimina, pero no la des por viva.

---

## 8. Lo que sigue sin resolver

- **El juez nunca ha aprobado nada.** El commit `6867722` debería cambiarlo, pero
  no está validado en producción.
- **107 de 133 alertas listas no llegan al modelo** — es la sección 5.
- **48 alertas de BOPA atascadas en `needs_evidence`**: el rescate está conectado
  y se ejecuta, pero devuelve `missing: 20` porque la fuente no sirve el texto.
- **El 80% de descarte del clasificador es correcto** (muestreado por arriba y por
  abajo). Hay falsos negativos reales —ayudas de consejerías de agricultura
  etiquetadas «no rural»— pero **ninguna señal barata los distingue del ruido**.
  Requiere mejorar el criterio del clasificador, no aflojar un umbral.

---

## 9. Orden recomendado

1. Fusionar `6867722` y **enviar**. Siete días de silencio pesan más que un
   diseño perfecto.
2. Leer dos o tres mensajes reales: ¿le sirve a esa persona?
3. Hacer la sección 5 **con esa referencia delante**. Sin un digest real con el
   que comparar, la reescritura se valida contra una simulación.

Comandos: `npm run lint`, `node scripts/run_tests.js`, `npm run check:core`.
El cron de producción es `node scripts/run_digest_workflow.js`, una vez al día.
