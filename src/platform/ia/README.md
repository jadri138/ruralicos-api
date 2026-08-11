# Integración de IA

Capa mínima de acceso a modelos y embeddings. Centraliza llamadas, diagnóstico y opciones del proveedor; las decisiones de negocio siguen en `modules/alertas`, `modules/digest`, `modules/aprendizaje` y `modules/mia`.

## Archivos

| Archivo | Uso |
| --- | --- |
| `llamarIA.js` | Ejecución de tareas generativas/estructuradas, extracción de contenido y diagnóstico |
| `embeddings.js` | Generación de vectores para similitud semántica |
| `modelPolicy.js` | Modelos económicos por nivel de tarea y razonamiento por defecto |

## Garantías esperadas

- Validar la salida estructurada antes de aceptarla.
- Registrar modelo, duración, resultado y error sin guardar secretos.
- Distinguir fallo técnico de una respuesta inválida.
- Limitar tamaño de entrada y salida.
- Evitar que el texto del documento cambie las instrucciones del sistema.
- No convertir una inferencia del modelo en hecho oficial sin evidencia.

## Uso correcto

Los módulos deben proporcionar una tarea acotada y verificar el resultado. Una llamada exitosa a la API no significa que el contenido sea correcto. Para alertas críticas se aplican ficha de hechos, trazabilidad, doble comprobación y validación final.

Pruebas principales: `llamarIA.test.js`, `embeddings.test.js`, `factSheetValidator.test.js`, `criticalDoubleCheck.test.js` y las evaluaciones de MIA.
