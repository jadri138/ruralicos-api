# Rutas estatales complementarias

Integraciones estatales que no siguen el boletín diario general.

## FEGA

`fega.js` registra `/scrape-fega-beneficiarios`. Consulta listados de beneficiarios, normaliza registros y puede cotejarlos con alertas/usuarios mediante el servicio de listados oficiales.

Está desactivado por defecto en el lote complementario salvo configuración:

- `COMPLEMENTARY_INCLUDE_FEGA`
- `PIPELINE_INCLUDE_FEGA`
- `FEGA_EJERCICIO`
- `FEGA_ENVIAR_MATCHES`

El cotejo no implica envío automático salvo que el interruptor correspondiente esté habilitado. Probar primero sin envío y revisar coincidencias desde el panel.
