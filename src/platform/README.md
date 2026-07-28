# Plataforma e integraciones

Adaptadores que conectan el negocio con servicios externos. El objetivo es que los módulos pidan una capacidad —consultar datos, llamar a IA, enviar WhatsApp— sin repetir configuración ni detalles del proveedor.

## Componentes

| Archivo/carpeta | Integración |
| --- | --- |
| `supabase.js` | Cliente servidor de Supabase |
| `httpClient.js` | Peticiones HTTP con comportamiento común |
| `dnsResiliente.js` | Resolución y reintentos frente a fallos DNS |
| `sentry.js` | Captura opcional de errores y cierres fatales |
| [`ia/`](ia/) | OpenAI y embeddings |
| [`whatsapp/`](whatsapp/) | UltraMsg, formato y envío |

## Principios

- La clave de servicio solo vive en el backend.
- Toda petición externa debe tener timeout y errores interpretables.
- Los reintentos solo se aplican a operaciones seguras o idempotentes.
- La lógica de “a quién enviar” no pertenece a esta carpeta.
- Un proveedor externo nunca es la fuente única de auditoría: se guarda el intento y el resultado relevante.
- En tests se inyectan clientes o se usan mocks; la suite local no debe enviar mensajes ni gastar API.

## Al cambiar un proveedor

1. Mantener estable la interfaz consumida por los módulos.
2. Mapear errores del proveedor a estados internos claros.
3. Ocultar secretos y PII en logs.
4. Probar timeout, error, respuesta parcial y éxito.
5. Revisar límites, costes, reintentos e idempotencia.
