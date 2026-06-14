# modules/digest

Genera y envía **un único mensaje de WhatsApp al día** por usuario, con las
alertas relevantes según su plan y preferencias. Si no hay nada relevante, no
se envía nada (silencio total).

## Estructura

- `digest.routes.js` — capa HTTP: registra los endpoints
  (`/alertas/preparar-digest`, `/alertas/enviar-digest`,
  `/alertas/preview-digest`, `/alertas/diagnosticar-digest`).
- `digest.service.js` — el motor: carga de alertas/usuarios, selección (con MIA
  y fallbacks), generación del mensaje IA, rescate semanal, tracking de enlaces
  y construcción del preview.

## Lógica por plan

- `corral` — solo BOE, límites estrictos de provincia/sector.
- `agricultor` — BOE + autonómicos, más límites y campo libre.
- `cooperativa` — todas las fuentes, sin límites, modelo IA más potente.
- `free` — no recibe digest (usa `alertas/alertasFree.routes.js`).

Configurable por entorno (`PREPARAR_DIGEST_BATCH_SIZE`, `DIGEST_RESCUE_*`,
`DIGEST_MAX_ALERTAS_*`…). Ver [.env.example](../../../.env.example).
