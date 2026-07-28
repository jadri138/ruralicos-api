# Aprendizaje

Sistema determinista que convierte acciones del usuario en señales útiles para ordenar alertas. Complementa las preferencias explícitas; nunca las sustituye ni rompe filtros duros.

## Archivos

| Archivo | Función |
| --- | --- |
| `feedbackParser.js` | Extrae referencias y valoración desde respuestas breves o naturales |
| `alertFeatures.js` | Convierte alertas en features comparables |
| `alertPriority.js` | Calcula prioridad y peso operativo |
| `taxonomiaRuralicos.js` | Taxonomía rural y detección de conceptos |
| `userInterestProfile.js` | Actualiza intereses positivos/negativos con decay |
| `miaProfile.js` | Recalcula el perfil consolidado usado por MIA/selección |
| `cerebro.js` | Operaciones de perfil y similitud |
| `cerebro.routes.js` | Inicialización, diagnóstico, backfill, exploración y ciclo diario |
| `index.js` | Exportación pública del módulo |

## Qué aprende

- temas y subtemas que reciben clic o feedback;
- señales negativas explícitas;
- recencia de las acciones;
- preferencias y memoria estructurada compatibles;
- afinidad semántica;
- respuesta a exploraciones controladas.

El peso decae con el tiempo para no convertir una acción antigua en una preferencia permanente.

## Lo que no puede hacer

- enviar una alerta de otra provincia incompatible;
- ignorar una exclusión explícita;
- rescatar contenido sin evidencia o calidad;
- asumir que un clic significa aprobación total;
- modificar el perfil por un mensaje ambiguo sin conservar confianza/origen.

## “Cerebro” y MIA

`/cerebro/*` es el subsistema de perfil y recomendación. `modules/mia/` es el agente conversacional. Comparten señales, pero no son lo mismo:

| Aprendizaje | MIA |
| --- | --- |
| reglas, features, scores y perfiles | conversación, decisiones, memoria y acciones |
| mayormente determinista | usa LLM bajo políticas |
| ordena contenido permitido | entiende y responde al usuario |

## Exploración

La exploración prueba un interés cercano con presupuesto limitado. Debe:

- mantenerse dentro de territorio y seguridad;
- estar claramente registrada;
- no desplazar contenido de alta relevancia;
- parar cuando genera rechazo o baja salud;
- aportar información medible al perfil.

`recommendationHealth` en MIA consolida métricas para detectar si personalización o exploración empeoran.

## Pruebas

`feedbackParser`, `clickLearningWeight`, `alertPriority`, `taxonomiaRuralicos`, `userInterestProfile`, `miaProfileRecalculation`, `miaExploration` y `miaRecommendationHealth`.
