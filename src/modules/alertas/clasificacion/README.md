# Clasificación y descarte

Primera barrera inteligente tras la ingesta. Reduce trabajo caro sin permitir que una heurística débil borre una alerta rural válida.

## Archivos

| Archivo | Función |
| --- | --- |
| `alertPreclassifier.js` | Preclasificación barata antes de IA |
| `discardDecision.js` | Decisión de descarte estructurada y auditable |
| `legacyDiscardRepair.js` | Traduce/repara descartes históricos sin explicación suficiente |
| `officialAlertMetadata.js` | Normaliza metadatos derivados de fuente oficial |
| `officialRuralEvidenceGate.js` | Exige señales rurales respaldadas por evidencia |

## Modos de preclasificación

`ALERT_PRECLASSIFIER_MODE`:

- `off`: no interviene.
- `observe`: calcula y registra, pero no descarta.
- `hard_exclusions`: aplica únicamente exclusiones consideradas duras.

Aunque producción use un modo agresivo, una exclusión debe tener código estable, explicación y evidencia. “La IA cree que no interesa” no es motivo suficiente.

## Regla de seguridad

Una señal positiva oficial/rural fuerte debe vencer a palabras genéricas de ruido. Los descartes por ausencia de señales son más arriesgados que los descartes por evidencia incompatible.

## Cambios

Antes de añadir una regla:

1. probarla contra el corpus auditado de falsos descartes;
2. registrar el motivo estructurado;
3. medir cuántas alertas y usuarios afectaría;
4. conservar una vía de reparación;
5. ejecutar `alertPreclassifier`, `officialRuralEvidenceGate`, `alertDiscardAudit` y regresiones auditadas.
