# shadow-v2

Motor shadow aislado con dos decisiones semanticas consecutivas:

1. un prefiltro determinista binario deja pasar solo alertas con organismo o vocabulario rural explícito, e IA 1 (`gpt-5-nano`) las clasifica globalmente;
2. un cruce determinista crea candidatas e IA 2 (`gpt-5.6-luna`) selecciona y redacta el digest personal.

No hay votacion, segunda opinion, reparacion semantica, scores, embeddings ni memoria. El modulo solo escribe en:

- `shadow_v2_alert_classifications`;
- `shadow_v2_digest_runs`;
- `shadow_v2_digest_items`.

No envia mensajes. El workflow diario lo ejecuta al final por `/tareas/shadow-v2`, una ruta interna protegida por `CRON_TOKEN`, con lotes reanudables y `RUN_SHADOW_V2=false` como apagado de emergencia. Un fallo shadow no bloquea el digest productivo.

El runner independiente se conserva para pruebas manuales y queda apagado salvo que se invoque con `SHADOW_V2_ENABLED=true`.

Ejemplo local limitado, una vez aplicada la migracion y con credenciales configuradas:

```powershell
$env:SHADOW_V2_ENABLED='true'
node scripts/run_shadow_v2_workflow.js --date=2026-08-12 --run-key=<UUID> --max-alerts=5 --max-users=1 --max-calls=6 --max-candidates=5
```

Reutilizar la misma `run-key` reanuda la ejecucion sin duplicar filas ya persistidas.
