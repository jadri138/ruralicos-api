# Módulos de negocio

Cada carpeta es dueña de una parte funcional del sistema. Este índice indica dónde mirar y cómo se conectan.

| Módulo | Responsabilidad | README |
| --- | --- | --- |
| `boletines` | Ingesta y salud de fuentes oficiales | [`boletines/README.md`](boletines/README.md) |
| `alertas` | Clasificación, evidencia, revisión, exclusiones y selección | [`alertas/README.md`](alertas/README.md) |
| `digest` | Composición, validación y entrega del resumen diario | [`digest/README.md`](digest/README.md) |
| `feedback` | Clics y valoración de alertas | [`feedback/README.md`](feedback/README.md) |
| `aprendizaje` | Features, scores y perfil de intereses | [`aprendizaje/README.md`](aprendizaje/README.md) |
| `mia` | Asistente conversacional, memoria y decisiones | [`mia/README.md`](mia/README.md) |
| `usuarios` | Registro, sesión, cuenta, preferencias y privacidad | [`usuarios/README.md`](usuarios/README.md) |
| `partner` | API multi-tenant para cooperativas | [`partner/README.md`](partner/README.md) |
| `admin` | API del panel interno y auditoría | [`admin/README.md`](admin/README.md) |
| `tareas` | Orquestación, cron y checkpoints | [`tareas/README.md`](tareas/README.md) |
| `embeddings` | Operaciones de vectorización | [`embeddings/README.md`](embeddings/README.md) |
| `taxonomy` | Sugerencia y análisis de taxonomía | [`taxonomy/README.md`](taxonomy/README.md) |

## Dependencias principales

```text
boletines → alertas → digest → WhatsApp
                ↑        ↓
       aprendizaje ← feedback/clics
                ↕
               MIA

usuarios ───────────────→ selección y digest
partner ────────────────→ contexto de organización
admin ──────────────────→ observación y operaciones
tareas ─────────────────→ coordina todas las fases
```

## Límites importantes

- `boletines` obtiene datos; no decide destinatarios.
- `alertas` decide relevancia y audiencia; no formatea el mensaje final.
- `digest` compone y valida; no redefine las preferencias.
- `aprendizaje` calcula señales; una señal aprendida nunca debe saltarse una exclusión dura.
- `mia` conversa y propone acciones dentro de políticas; no ejecuta libremente efectos sensibles.
- `admin` expone información y operaciones, pero reutiliza la lógica de los módulos dueños.
- `tareas` coordina; no debe duplicar la lógica interna de cada fase.

## Contrato de calidad

Todo cambio que pueda afectar un envío debe contestar:

1. ¿Qué evidencia lo respalda?
2. ¿Qué regla permitió o bloqueó al usuario?
3. ¿Cómo se evita otra provincia o sector incompatible?
4. ¿Cómo se evita un duplicado?
5. ¿Qué ocurre si IA, fuente o proveedor falla?
6. ¿Dónde queda registrada la decisión?
7. ¿Qué prueba detectaría una regresión?
