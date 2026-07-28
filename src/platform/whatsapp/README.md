# WhatsApp

Adaptador de envío mediante UltraMsg. Expone capacidades comunes para mensajes individuales y masivos, y separa la comunicación con el proveedor del sistema de digest y de la cola.

## Archivos

| Archivo | Uso |
| --- | --- |
| `client.js` | Cliente HTTP y autenticación contra UltraMsg |
| `mensajes.js` | Construcción/envío de operaciones comunes |
| `index.js` | Exportación pública de la integración |

## Flujo recomendado

```text
digest validado
  → registro de intento/outbox
  → adaptador WhatsApp
  → respuesta del proveedor
  → estado enviado, reintento o fallo
```

La cola y los reintentos de negocio viven en `modules/digest/digestOutbox.js` y `modules/mia/outbox.js`.

## Seguridad operativa

- Nunca imprimir token, instancia o teléfono completo.
- Normalizar el teléfono antes de llamar al proveedor.
- Respetar `DIGEST_DELAY_MS` y límites anti-spam.
- No reintentar indefinidamente.
- Usar claves de deduplicación para impedir dobles envíos.
- Un `200` del proveedor no sustituye el registro interno del intento.
- En pruebas locales, el cliente debe estar simulado.

El webhook entrante no se procesa aquí: `modules/mia/inbound.js` y `modules/feedback/` validan, deduplican e interpretan las respuestas.
