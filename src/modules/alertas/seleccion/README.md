# Selección por usuario

Motor que responde: “¿debe esta alerta formar parte del digest de esta persona, y por qué?”.

## Archivos

| Archivo | Función |
| --- | --- |
| `alertaMatcher.js` | Normaliza y compara provincia, sector, subsector y tipo |
| `alertSelectionGate.js` | Barreras previas que una puntuación no puede saltarse |
| `alertSelectionEngine.js` | Señales, puntuación, decisión y diversidad |
| `alertCandidateMerge.js` | Fusiona candidatas procedentes de varias estrategias sin duplicar |
| `audienceReach.js` | Calcula y registra a quién podría alcanzar una alerta |

## Decisión por capas

```text
candidata
  ├─ ¿calidad/evidencia válidas?
  ├─ ¿territorio compatible?
  ├─ ¿sector compatible?
  ├─ ¿preferencias/exclusiones compatibles?
  ├─ ¿valor y acción suficientes?
  └─ score + diversidad
       → incluir / revisión segura / excluir
```

## Reglas innegociables

- Una alerta provincial no se convierte en nacional porque el texto mencione España.
- Un perfil vacío no autoriza contenido crítico o de baja calidad.
- El aprendizaje ordena candidatos permitidos; no elimina bloqueos.
- Una señal semántica no reemplaza territorio o sector explícitos.
- Cada exclusión debe devolver un motivo legible.
- La diversidad nunca debe rescatar una alerta bloqueada.

## Medición

Además de aciertos aparentes, vigilar:

- falsos descartes;
- alertas fuera de provincia;
- repetición de fuente/tipo;
- cobertura de usuarios;
- clic y feedback por razón de selección;
- `no_send_reason`;
- porcentaje de revisión segura y degradación de calidad.

Pruebas clave: `alertaMatcher`, `alertCandidateMerge`, `alertSelectionGate`, `alertSelectionEngine`, `audienceReach` y corpus auditados.
