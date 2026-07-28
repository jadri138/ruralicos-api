# Documentos brutos

Conserva la captura previa a la inteligencia. Permite reproducir qué vio el sistema y por qué creó, retuvo o saltó una alerta.

`rawDocuments.service.js` normaliza la identidad del documento, calcula claves de deduplicación y persiste contenido/metadatos de la fuente.

## Estados esperables

- detectado/capturado;
- procesado a alerta;
- duplicado;
- saltado por regla con motivo;
- pendiente de evidencia o detalle;
- error de extracción.

Los nombres exactos se rigen por el esquema vigente en migraciones.

## Principios

- No perder un anuncio detectado porque falle una descarga secundaria.
- La URL y el ID oficial tienen prioridad sobre títulos variables.
- Conservar hash/versiones para saber si el contenido cambió.
- Limitar tamaño y limpiar binarios/texto antes de persistir.
- No mezclar el texto bruto con el resumen generado.
- Registrar fuente, fecha objetivo, ejecución y razón de skip.

Pruebas: `rawDocuments.test.js`, `insertarAlertasBoletin.test.js` y procesadores de boletín.
