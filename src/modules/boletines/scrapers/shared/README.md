# Utilidades compartidas de scrapers

## Archivos

- `ruralFilter.js`: crea decisiones `pass`, `review` o `discard` con señales y razón.
- `portalErrorText.js`: detecta HTML de error, mantenimiento, proxy o bloqueo que podría confundirse con una publicación vacía.

## Regla esencial

Un resultado sin documentos solo es “no publication” cuando la fuente ofrece evidencia clara de ello. Una página de error con HTTP 200 no es éxito.

El filtro compartido debe favorecer la conservación en casos ambiguos. Las exclusiones duras se reservan para señales incompatibles suficientemente específicas.
