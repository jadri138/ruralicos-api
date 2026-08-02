# Pruebas locales

Las pruebas locales no deben llamar a OpenAI, enviar WhatsApp ni escribir en una
base de datos real.

## Comandos

Desde `ruralicos-api`:

```powershell
# Una prueba concreta durante el desarrollo
node tests\alertSelectionEngine.test.js

# Reglas críticas rápidas
npm.cmd run check:core

# Suite completa
npm.cmd run test:local

# Calidad estática
npm.cmd run lint
```

`npm.cmd test` ejecuta lint, suite local y reglas críticas. En Windows se usa
`npm.cmd` cuando PowerShell bloquea `npm.ps1`.

## Elegir la prueba

| Cambio | Empezar por |
| --- | --- |
| Territorio, sector o tipo | `alertaMatcher`, `alertSelectionEngine` |
| Clasificación o descarte | `alertDiscardAudit`, corpus auditado |
| Digest y validación | `digest*`, `finalDigestValidator` |
| Workflow diario | `runDigestWorkflow*` |
| Fuente | prueba del scraper + `scraperRunQuality` |
| Feedback o MIA | prueba del módulo afectado |
| Replay de decisiones | `alertDecisionReplay`, `alertDecisionHistoricalReplay` |
| Contexto/documentación | `npm.cmd run context:check` |

## Replay sin efectos reales

```powershell
node tests\alertDecisionReplay.test.js
node tests\alertDecisionHistoricalReplay.test.js
npm.cmd run replay:alert-decisions
```

Estas pruebas sustituyen el grader por una función local, bloquean la red y
usan un cliente Supabase falso. No se deben probar el exportador contra
producción ni activar `replay:grade` dentro de la suite.

## Interpretar fallos

1. Ejecuta primero el archivo que falla directamente con Node.
2. Comprueba si el fallo viene de tu cambio o de una dependencia externa.
3. No arregles una prueba debilitando una regla de seguridad.
4. Repite `npm.cmd run test:local` antes de terminar un cambio amplio.

La suite se descubre automáticamente desde `tests/*.test.js`; no hay que
mantener una lista manual.
