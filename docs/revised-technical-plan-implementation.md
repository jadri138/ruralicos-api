# Estado de implementación del plan técnico revisado

Fecha de corte: 21 de julio de 2026. Este estado describe el repositorio; no
equivale a despliegue ni a saneamiento de datos en producción.

## P0 — Protección inmediata

| Punto | Estado | Implementación y prueba |
| --- | --- | --- |
| P0.1 | Implementado | Prefiltro estructurado `pass/review/discard`; conserva señales rurales explícitas y descarta ruido administrativo. |
| P0.2 | Implementado | Taxonomía vacía o especializada sin tipo queda en revisión antes del scoring. |
| P0.3 | Implementado | Contrato de descarte con motivo, código, confianza, etapa y auditoría. |
| P0.4 | Implementado | Reparación temática elimina cruces no respaldados, incluido el caso de antibióticos. |
| P0.5 | Implementado | Barrera previa al scoring: sanidad animal exige perfil ganadero o mixto. |
| P0.6 | Implementado | El envío automático falla cerrado sin `decision_digest`; rescate legacy limitado por modo y fecha. |
| P0.7 | Implementado | Prueba E2E de antibióticos desde clasificación hasta digest final. |
| P0.8 | Implementado | Regresiones de forestal, ruido, alcance intersectorial y taxonomía vacía. |

La matriz ejecutable completa está en `scripts/p0-acceptance/guarantees.json` y
su vista operativa en `p0-acceptance-matrix.md`.

## P1 — Calidad semántica y de decisión

| Punto | Estado | Implementación |
| --- | --- | --- |
| P1.1 | Implementado | Cálculo de alcance anómalo, distribución y motivos de exclusión; el alcance alto solo bloquea si concurre incompatibilidad o conflicto taxonómico. |
| P1.2 | Implementado | Fechas de publicación, vigencia, solicitud, alegaciones, recurso y justificación separadas en la ficha factual. |
| P1.3 | Implementado | Relación documental: duplicado exacto, republicación, corrección, actualización y nuevo trámite del mismo asunto. |
| P1.4 | Implementado | Evidencia, campo fuente, confianza y nivel por etiqueta; etiquetas sin soporte fuerzan revisión. |
| P1.5 | Implementado | Tipos ampliados conservando los seis tipos anteriores y sus alias. |
| P1.6 | Implementado | Acciones normalizadas mediante códigos; si no hay acción respaldada se usa `no_detectado`. |
| P1.7 | Implementado | Resumen estructurado: marco previo, acto actual, cambio práctico, afectados, fecha y acción. |

## P2 — Operación y observabilidad

| Punto | Estado | Implementación |
| --- | --- | --- |
| P2.1 | Implementado | Los jobs `running` sin heartbeat vuelven a ser reclamables y el diagnóstico separa stale, heartbeat ausente y etapa actual. |
| P2.2 | Implementado | El corpus y gate reproducen los fallos reales de P0.1–P0.8. |
| P2.3 | Implementado | Preview admin del alcance de una alerta, con incluidos, excluidos, razones y advertencias. |
| P2.4 | Implementado | Métricas exactas para cobertura de descarte, taxonomía, cruces, decisiones ausentes, envíos indebidos y falsos positivos/negativos confirmados. |
| P2.5 | Implementado | Trazabilidad por usuario de territorio, sector, subsector, tipo, score, decisión y motivo. |

## Pendiente operativo, fuera de cambios de código

- Ejecutar el gate sobre un commit limpio y contra staging con credenciales de
  solo lectura.
- Aplicar, si el inventario lo exige, el backfill controlado de descartes
  históricos y validar la constraint correspondiente.
- Desplegar y verificar en entorno real las métricas, el preview y la
  recuperación de jobs; este trabajo no toca producción automáticamente.
