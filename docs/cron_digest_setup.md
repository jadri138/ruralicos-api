# Cron setup recomendado (Ruralicos)

El camino recomendado es un unico cron frecuente contra el runner reanudable:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-tick"
```

Si Render aun tiene programado `node scripts/run_digest_workflow.js`, no hace
falta cambiarlo de inmediato: el script actua como puente y conduce el mismo
job reanudable de `pipeline-tick` hasta completarlo. No ejecuta un segundo flujo
independiente. El runner antiguo solo se activa para un rescate puntual con
`ALLOW_LEGACY_DIGEST_WORKFLOW=true` y tras pausar temporalmente cualquier otro
cron de `pipeline-tick`.

Ese endpoint ejecuta, en orden:

1. Scrapers BOE y boletines autonomicos.
2. Scrapers complementarios provinciales configurados.
3. FEGA, solo si se activa.
4. Cotejo de listados oficiales.
5. Reparacion de pendientes IA.
6. Clasificar, resumir y revisar por lotes hasta vaciar cola.
7. Deduplicar.
8. Preparar y enviar digest.
9. Generar y enviar resumen free.

## Variables necesarias

- `BASE_URL` (ej. `https://tu-api.onrender.com`)
- `CRON_TOKEN` (debe coincidir con el del backend)
- `PUBLIC_BASE_URL` en la API para enlaces publicos
- Opcional: `PIPELINE_INTERNAL_BASE_URL` en la API si quieres fijar el dominio
  usado por autocalls internos del pipeline

Recomendacion operativa: usa como `BASE_URL` el dominio que responda realmente
a `/health` (por ejemplo el `.onrender.com`). No uses un dominio custom para el
cron hasta que el DNS este activo.

El backend valida token por header `x-cron-token` o Bearer token.
El query string (`?token=...`) queda como compatibilidad local/opt-in.

## Boletines provinciales

Los provinciales entran en el pipeline diario mediante:

```text
COMPLEMENTARY_SCRAPE_PATHS=/scrape-botha-oficial
```

Para sumar otro boletin provincial, anade su endpoint separado por coma:

```text
COMPLEMENTARY_SCRAPE_PATHS=/scrape-botha-oficial,/scrape-nuevo-bop-oficial
```

`PIPELINE_INCLUDE_COMPLEMENTARY` viene activado por defecto. Solo ponlo a
`false` si quieres sacar los provinciales del pipeline diario.

## FEGA

FEGA es una fuente especial y puede ser pesada, por eso no se activa por defecto
salvo que lo indiques:

```text
PIPELINE_INCLUDE_FEGA=true
FEGA_EJERCICIO=2024
FEGA_ENVIAR_MATCHES=false
```

Tambien puedes lanzarlo puntualmente:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-tick?fega=true&ejercicio=2024"
```

Antes de activar envios individuales de coincidencias nominales, comprueba que
existen en Supabase las columnas de identidad legal en `users` y la tabla
`official_list_matches`. Ya no se mantienen SQL sueltos en `docs`; usa la
migracion operativa vigente.

## Horario recomendado

Cada 10 minutos durante la ventana de publicación. Cada llamada retoma el
checkpoint anterior y no repite fases completadas. Ejemplo UTC:

```cron
*/10 6-14 * * * curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/pipeline-tick"
```

En hora peninsular, ajusta segun invierno/verano y segun la hora real de
publicacion de las fuentes que mas te importen.

## Endpoints auxiliares

Estos siguen disponibles para pruebas o relanzar partes concretas:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/scrapers-diario"
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/complementarios-diario"
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/tareas/cotejar-listados-oficiales?enviar=false"
```

Para diagnosticar por que un usuario recibiria o no recibiria una alerta:

```bash
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/alertas/diagnosticar-digest?phone=600000000"
curl -fsS -H "x-cron-token: $CRON_TOKEN" "$BASE_URL/alertas/diagnosticar-digest?user_id=123&fecha=2026-04-29"
```

Mantener desactivado el flujo legacy por alerta individual
(`/alertas/enviar-whatsapp`) mientras `DIGEST_ONLY_MODE=true`.
