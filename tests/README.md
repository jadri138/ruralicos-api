# Pruebas

Suite local basada en archivos Node ejecutables, sin un framework global. Cada `*.test.js` se lanza en un proceso separado para aislar mocks y variables.

## Ejecutar

```powershell
node tests\alertSelectionEngine.test.js  # una prueba
node scripts\run_tests.js digest         # grupo por nombre
npm run test:local                       # toda la suite
npm run check:core                       # invariantes
npm test                                 # lint + suite + invariantes
```

La suite local no debe llamar a OpenAI, enviar WhatsApp ni modificar una base real.

## Cobertura por dominio

| Grupo | Ejemplos |
| --- | --- |
| Selección y filtros | `alertaMatcher`, `alertSelectionGate`, `alertSelectionEngine`, `audienceReach` |
| Evidencia | `factSheet*`, `documentTrace`, `documentRelation`, `criticalDoubleCheck` |
| Digest | `digest*`, `finalDigestValidator`, `finalValidationAuthority` |
| MIA | `mia*.test.js`, inbound, policy, memoria, replay y evals |
| Boletines | procesadores comunes, BOPA, Aragón, salud y resiliencia |
| Usuarios/seguridad | verificación, contraseña, credenciales, validación y borrado |
| Partner | `tenantClient`, `partnerTenantIsolation` |
| Pipeline | runner, sombra, stale jobs y workflow |
| Infraestructura | DNS, base URL, IA, embeddings y errores |

## Fixtures

`fixtures/` contiene corpus versionados:

- `audited-2026-07-21/`: falsos descartes y autoridad final auditados.
- `p0/`: corpus y bordes de aceptación.
- `acceptance/`: métricas del plan.
- `bopz/`: escenarios de resiliencia.
- `pipeline/`: jobs obsoletos de sombra.

Un fixture debe ser mínimo, anónimo y estable. No guardar documentos completos si basta un fragmento ni introducir PII real.

## Escribir una prueba

1. Nombre `<comportamiento>.test.js`.
2. Importar la unidad y simular sus dependencias.
3. Cubrir éxito, bloqueo y error.
4. Si cambia un filtro, añadir pareja positiva/negativa.
5. Si corrige un incidente, conservar un caso de regresión.
6. Restaurar `process.env`, timers y mocks al terminar.
7. Salir con código distinto de cero al fallar.

## Cambios de alto riesgo

Para geografía, descarte, validación final o tenant, no basta un caso feliz. Ejecutar los corpus auditados y demostrar que:

- no aparece otra provincia;
- no se pierde evidencia rural válida;
- un bloqueo no es rescatado por score;
- un tenant no ve datos ajenos;
- reintentar no duplica un envío.
