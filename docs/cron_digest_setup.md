# Cron setup recomendado (Ruralicos)

El camino recomendado es un unico cron diario contra el pipeline completo:

```bash
curl -fsS "$BASE_URL/tareas/pipeline-diario?token=$CRON_TOKEN"
```

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
- `PUBLIC_BASE_URL` en la API, apuntando al mismo servicio publico

El backend valida token en query string (`?token=...`), header `x-cron-token`
o Bearer token.

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
curl -fsS "$BASE_URL/tareas/pipeline-diario?token=$CRON_TOKEN&fega=true&ejercicio=2024"
```

Antes de activar envios individuales de coincidencias nominales, comprueba que
existen en Supabase las columnas de identidad legal en `users` y la tabla
`official_list_matches`. Ya no se mantienen SQL sueltos en `docs`; usa la
migracion operativa vigente.

## Horario recomendado

Una vez al dia, despues de que los boletines del dia suelan estar disponibles.
Ejemplo UTC:

```cron
0 6 * * * curl -fsS "$BASE_URL/tareas/pipeline-diario?token=$CRON_TOKEN"
```

En hora peninsular, ajusta segun invierno/verano y segun la hora real de
publicacion de las fuentes que mas te importen.

## Endpoints auxiliares

Estos siguen disponibles para pruebas o relanzar partes concretas:

```bash
curl -fsS "$BASE_URL/tareas/scrapers-diario?token=$CRON_TOKEN"
curl -fsS "$BASE_URL/tareas/complementarios-diario?token=$CRON_TOKEN"
curl -fsS "$BASE_URL/tareas/cotejar-listados-oficiales?token=$CRON_TOKEN&enviar=false"
```

Para diagnosticar por que un usuario recibiria o no recibiria una alerta:

```bash
curl -fsS "$BASE_URL/alertas/diagnosticar-digest?phone=600000000&token=$CRON_TOKEN"
curl -fsS "$BASE_URL/alertas/diagnosticar-digest?user_id=123&fecha=2026-04-29&token=$CRON_TOKEN"
```

Mantener desactivado el flujo legacy por alerta individual
(`/alertas/enviar-whatsapp`) mientras `DIGEST_ONLY_MODE=true`.
