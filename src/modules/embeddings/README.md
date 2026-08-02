# Embeddings

Endpoints operativos para crear vectores de alertas y recalcular perfiles semánticos. La implementación de proveedor vive en `platform/ia/embeddings.js`; este módulo coordina lotes y persistencia.

## Endpoints

| Endpoint | Función |
| --- | --- |
| `/embeddings/generar-alertas` | Genera vectores ausentes de alertas |
| `/embeddings/actualizar-perfil/:userId` | Recalcula el perfil de una persona |
| `/embeddings/ciclo-completo` | Coordina ambas operaciones |

Algunas rutas admiten GET por compatibilidad de cron. Deben mantenerse protegidas.

## Uso en recomendaciones

La similitud semántica es una señal de ranking. No autoriza por sí sola:

- otra provincia;
- un sector incompatible;
- contenido descartado;
- una alerta sin evidencia;
- una exclusión expresa.

## Operación

- Procesar por lotes pequeños.
- Evitar regenerar vectores sin cambios.
- Registrar modelo/dimensión o versión compatible.
- No mezclar embeddings de modelos incompatibles en una misma comparación.
- Tratar una llamada fallida como reintentable, no como vector vacío.

Pruebas: `embeddings.test.js`, perfiles de MIA y flujo de cerebro.
