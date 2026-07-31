# Render: configuración rápida

## Cron Job de producción

Comando:

```bash
node scripts/run_digest_workflow.js
```

Variables del cron:

- `BASE_URL=https://ruralicos-api.onrender.com`
- `CRON_TOKEN`, idéntico al configurado en la API

Usa una sola ejecución diaria después de la publicación de boletines. No
programes `/tareas/pipeline-tick` ni una frecuencia de diez minutos.

## Variables mínimas en la API

- `CRON_TOKEN`
- `PUBLIC_BASE_URL=https://ruralicos-api.onrender.com`, o el dominio público
  solo cuando su DNS responda correctamente
- Credenciales de Supabase, OpenAI y UltraMsg descritas en `.env.example`

## Vigía de fuentes

Este segundo cron diario es independiente y solo avisa al administrador si una
fuente acumula fallos:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/salud-fuentes"
```

Acepta `?dias=7`, `?min_dias=2` y `?enviar=false`. Requiere
`ADMIN_ALERT_PHONE` o `ADMIN_ALERT_PHONES` para enviar el aviso.

## Checklist

- [ ] El esquema de Supabase está aplicado.
- [ ] `CRON_TOKEN` coincide en la API y el Cron Job.
- [ ] `BASE_URL/health` responde.
- [ ] El cron ejecuta `node scripts/run_digest_workflow.js` una vez al día.
- [ ] No existe otro cron llamando a `/tareas/pipeline-tick`.
