# Matriz de aceptación del plan revisado

Esta matriz relaciona cada garantía de P0.1 a P0.8 del plan técnico revisado con pruebas ejecutables. La
fuente máquina-legible utilizada por el gate es
`scripts/p0-acceptance/guarantees.json`; este documento es su vista operativa.

El corpus mínimo está versionado en
`tests/fixtures/p0/acceptance-corpus.json` y se valida en
`tests/p0AcceptanceCorpus.test.js`.

## Garantías del plan revisado

| Garantía | Resultado exigido | Pruebas principales |
| --- | --- | --- |
| RP0.1-G1 | Prefiltro `pass/review/discard`; una señal administrativa no elimina materia rural explícita | `ruralRoutePrefilter.test.js`, `procesarConFiltroRural.test.js`, `p0AcceptanceCorpus.test.js` |
| RP0.2-G1 | Taxonomía vacía y alerta especializada sin tipo quedan en `review` | `alertaMatcher.test.js`, `alertSelectionEngine.test.js`, `p0AcceptanceCorpus.test.js` |
| RP0.3-G1 | Todo descarte nuevo conserva motivo, código, confianza, etapa y auditoría | `discardTraceabilityContract.test.js`, `alertDiscardAudit.test.js`, `p0AcceptanceCorpus.test.js` |
| RP0.4-G1 | Sanidad animal elimina cultivos, agua y fiscalidad no respaldados | `taxonomyRegistry.test.js`, `alertaMatcher.test.js`, `p0AcceptanceCorpus.test.js` |
| RP0.5-G1 | Sanidad animal exige perfil ganadero o mixto antes del scoring | `alertaMatcher.test.js`, `alertSelectionEngine.test.js`, `p0AcceptanceCorpus.test.js` |
| RP0.6-G1 | `decision_digest` ausente falla cerrada; legacy exige modo y fecha explícitos | `digestAutoSendGuard.test.js`, `p0AcceptanceCorpus.test.js` |
| RP0.7-G1 | Antibióticos recorre clasificación, taxonomía, quality gate, matcher, selección y digest final | `antibioticsEndToEnd.test.js` |
| RP0.8-G1 | Regresiones forestal, ruido, alcance intersectorial y taxonomía vacía | `ruralRoutePrefilter.test.js`, `alertaMatcher.test.js`, `p0AcceptanceCorpus.test.js` |

## Defensas base conservadas

| Garantía | Resultado exigido | Pruebas principales |
| --- | --- | --- |
| BASE-TAX-G1 | Taxonomía vacía o incoherente bloqueada antes del scoring | `alertaMatcher.test.js`, `alertSelectionEngine.test.js`, `p0AcceptanceCorpus.test.js` |
| BASE-TAX-G2 | Sector explícito prioritario e inferencia sectorial diagnosticada | `alertaMatcher.test.js`, `alertSelectionEngine.test.js` |
| BASE-GEO-G1 | Comunidad expandida y provincia concreta prioritaria | `alertaMatcher.test.js`, `p0AcceptanceCorpus.test.js` |
| BASE-BOPA-G1 | Error o placeholder BOPA queda sin evidencia y nunca llega a `listo` | `bopaEvidence.test.js`, `p0AcceptanceCorpus.test.js` |
| BASE-BOPA-G2 | Evidencia BOPA útil reactiva la misma alerta de forma idempotente | `bopaEvidence.test.js`, `p0AcceptanceCorpus.test.js` |
| BASE-RURAL-G1 | Los seis negativos DOGC/DOE se descartan antes de `listo` | `officialRuralEvidenceGate.test.js`, `alertDiscardAudit.test.js`, `p0AcceptanceCorpus.test.js` |
| BASE-RURAL-G2 | Los controles agrarios positivos continúan normalmente | `officialRuralEvidenceGate.test.js`, `alertDiscardAudit.test.js`, `p0AcceptanceCorpus.test.js` |
| BASE-RURAL-G3 | Campos generados, incluido `taxonomy_tags`, no prueban relevancia rural | `officialRuralEvidenceGate.test.js`, `alertDiscardAudit.test.js` |
| BASE-RURAL-G4 | Estados retenidos son visibles y no alcanzan `listo` automáticamente | `alertDiscardAudit.test.js`, `p0AcceptanceCorpus.test.js` |
| BASE-DISCARD-G1 | Todo descarte nuevo tiene cinco campos estructurados y conserva auditoría | `discardTraceabilityContract.test.js`, `alertDiscardAudit.test.js`, `p0AcceptanceCorpus.test.js` |
| BASE-DISCARD-G2 | Legacy desconocido usa `legacy_unstructured_discard` sin inventar motivo | `discardTraceabilityContract.test.js`, `p0AcceptanceCorpus.test.js` |
| BASE-DISCARD-G3 | `NO IMPORTA` no decide el estado y la constraint protege nuevos descartes | `discardTraceabilityContract.test.js`, `alertDiscardAudit.test.js` |

## Cobertura del corpus

El corpus contiene deliberadamente texto mínimo y no datos personales:

- seis negativos oficiales simulados a partir de las familias conocidas:
  privacidad, premio musical, centro educativo privado, instalación de gas,
  urbanismo industrial/terciario y autorización ambiental de fertilizantes;
- dos controles agrarios positivos: ayuda PAC y normativa de sanidad animal;
- expansión de Extremadura y restricción a Girona dentro de Cataluña;
- una taxonomía agricultura/ovino incoherente;
- BOPA con error del portal y BOPA con evidencia recuperada útil;
- descarte legacy estructurado y descarte legacy incompleto;
- `pendiente_revision_manual` y `needs_evidence`, ambos sin ruta automática a
  `listo`;
- un inventario agregado de ejemplo con constraint presente pero todavía no
  validada y una fila histórica pendiente de P0.7.

## Regla de mantenimiento

Una garantía nueva o modificada debe actualizar conjuntamente:

1. `scripts/p0-acceptance/guarantees.json`;
2. la prueba que la demuestra;
3. el fixture, si depende de un caso documental;
4. esta vista operativa.

El gate falla si falta alguna garantía P0.1–P0.8 en la matriz, si una
garantía no tiene pruebas o si alguno de sus ficheros de prueba no existe.
