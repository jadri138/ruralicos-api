# Runner con checkpoints: retirado

`/tareas/pipeline-tick` no es el orquestador de producción.

El sistema dividía el día en ticks y guardaba claims, heartbeats y checkpoints
en `pipeline_jobs`. En el incidente del 31 de julio de 2026 quedó atrapado en la
primera fase (`scrapers`): distintos ticks recuperaron repetidamente el mismo
job, pero ninguno produjo un checkpoint ni inició un `pipeline_run` real.

La solución adoptada es más simple: Render ejecuta una vez al día
`node scripts/run_digest_workflow.js`, que recorre todas las fases en orden y
falla de forma visible si una fase obligatoria no progresa.

Los archivos y tablas del runner se conservan temporalmente para poder auditar
el incidente, pero no deben conectarse a ningún cron. El estado histórico puede
consultarse en `/tareas/pipeline-jobs`; no se debe reabrir ni resetear para
ejecutar el pipeline diario.

Configuración vigente: [`cron_digest_setup.md`](cron_digest_setup.md).
