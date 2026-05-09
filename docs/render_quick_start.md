# Render: configuración rápida (sin Workflows Beta)

Si estás viendo la pantalla de **Workflows Beta** de Render, puedes saltártela.

Para tu caso, la opción más simple y estable es:

1. Subir el repo con `scripts/run_digest_workflow.js`.
2. Crear **un único Cron Job** en Render (no hace falta TypeScript/Python workflow).
3. Comando del cron:

```bash
npm run workflow:digest
```

4. Variables de entorno del cron:

- `BASE_URL=https://TU-SERVICIO.onrender.com`
- `CRON_TOKEN=tu_token`
- opcional `MAX_LOOPS=40`
- opcional `STEP_DELAY_MS=800`

5. Frecuencia recomendada:

- 1 vez al día (ejemplo UTC): `0 6 * * *`

---

## ¿Y la página de Workflows Beta?

Úsala solo si quieres programar lógica más compleja (ramas, tareas paralelas, etc.).
Para el pipeline actual no es necesario: el script `workflow:digest` ya hace bucles,
reintentos por lotes y orden correcto de pasos.

---

## Checklist final

- [ ] `docs/supabase_digest_schema.sql` ejecutado en Supabase
- [ ] `CRON_TOKEN` configurado en la API
- [ ] `ULTRAMSG_WEBHOOK_TOKEN` configurado en la API
- [ ] Webhook de UltraMsg apuntando a `/webhooks/ultramsg/feedback?token=TU_TOKEN`
- [ ] Cron Job en Render con `npm run workflow:digest`
- [ ] Variables `BASE_URL` y `CRON_TOKEN` en el Cron Job
