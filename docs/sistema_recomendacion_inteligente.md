# Sistema de Recomendación Inteligente para Ruralicos

## Resumen Ejecutivo

Ruralicos es una plataforma de alertas agrarias que envía digests diarios de WhatsApp con información relevante sobre subvenciones, normativas y oportunidades para agricultores y ganaderos. El sistema ha evolucionado de un enfoque estático basado en preferencias manuales a un **motor de aprendizaje inteligente** que entiende feedback en lenguaje natural y mejora automáticamente las recomendaciones.

## Arquitectura General

### Componentes Principales

1. **Parser de Feedback Natural (NLP)**
   - Analiza mensajes de WhatsApp en español natural
   - Extrae sentimientos (positivo/negativo/neutral) y temas mencionados
   - No requiere "+1" o "-2"; entiende frases como "Me interesa el olivar en Castellón"

2. **Perfil de Intereses del Usuario**
   - Tabla `user_interest_profile` en Supabase
   - Tags con scores: "subsector:olivar", "provincia:castellón", etc.
   - Aprende de cada feedback: +1 para intereses positivos, -1 para negativos

3. **Embeddings Semánticos**
   - Convierte texto en vectores de 1536 dimensiones
   - Calcula similitud coseno entre alertas y preferencias del usuario
   - Soporta OpenAI real o mock local para testing

4. **Decay Temporal**
   - Feedback reciente pesa más que el antiguo
   - Curva exponencial: feedback de hace 120 días casi no cuenta
   - Evita que preferencias viejas dominen recomendaciones

5. **Sistema de Digest Personalizado**
   - Filtra alertas por plan del usuario (corral/agricultor/cooperativa)
   - Ordena por perfil aprendido + prioridad inherente de la alerta
   - Genera mensaje IA personalizado con contexto del usuario

## Flujo de Aprendizaje

```
Usuario recibe digest → Responde feedback natural → Sistema aprende → Mejora próximos digests
```

### Ejemplo de Aprendizaje

**Mensaje del usuario:** "Me interesa mucho el olivar en Castellón pero no quiero ver porcino"

**Análisis del sistema:**
- Sentimiento: positivo
- Temas positivos: ['olivar', 'castellón']
- Temas negativos: ['porcino']

**Actualización del perfil:**
- `subsector:olivar` score +1
- `provincia:castellón` score +1  
- `subsector:porcino` score -1

**Próximas recomendaciones:**
- Alertas sobre olivar tendrán mayor prioridad
- Alertas sobre porcino serán filtradas o relegadas

## Funciones Clave

### Parser de Feedback (`src/brain/feedbackParser.js`)

```javascript
// Función principal: entiende TODO lo que escribe el usuario
async function analizarFeedbackCompleto(textoUsuario, alertaContexto = null) {
  // 1. Entender intención con IA (positivo/negativo/neutral)
  // 2. Extraer menciones positivas/negativas
  // 3. Combinar y devolver aprendizaje
  return {
    sentimiento: 'positivo',
    aprende_positivo: ['olivar', 'castellón'],
    aprende_negativo: ['porcino'],
    confianza: 0.85,
    es_valido: true
  };
}
```

### Perfil de Intereses (`src/brain/userInterestProfile.js`)

```javascript
// Leer perfil aprendido del usuario
async function leerPerfilIntereses(supabase, userId) {
  // Devuelve pesos para ordenar alertas + resumen textual
}

// Aplicar feedback al perfil
async function aplicarFeedbackAlPerfil(supabase, { userId, alerta, delta }) {
  // Actualiza scores en user_interest_profile
}
```

### Embeddings (`src/utils/embeddings.js`)

```javascript
// Generar embedding de texto
async function generarEmbedding(texto, forzarMock = false) {
  // OpenAI real o mock determinista
}

// Calcular similitud semántica
function similitudCoseno(vector1, vector2) {
  // Número entre -1 y 1
}
```

### Decay Temporal (`src/utils/decay.js`)

```javascript
// Calcular peso de feedback por antigüedad
function calcularPesoDecay(fecha, fechaActual = new Date()) {
  // 0-30 días: 1.0, 30-60: 0.5, etc.
}
```

## Endpoints de la API

### `/feedback/parse` (POST)
Analiza texto de feedback sin guardar.

**Request:**
```json
{
  "texto": "Me interesa el olivar pero no el porcino",
  "alertaContexto": { "titulo": "...", "sectores": ["..."] }
}
```

**Response:**
```json
{
  "ok": true,
  "texto": "Me interesa el olivar pero no el porcino",
  "resultado": {
    "sentimiento": "positivo",
    "aprende_positivo": ["olivar"],
    "aprende_negativo": ["porcino"],
    "confianza": 0.9,
    "es_valido": true
  }
}
```

### `/embeddings/test` (POST)
Prueba embeddings y similitud.

**Request:**
```json
{
  "text": "Subvenciones olivar",
  "otherText": "Ayudas agricultura",
  "forceMock": true
}
```

**Response:**
```json
{
  "ok": true,
  "text": "Subvenciones olivar",
  "embedding_length": 1536,
  "other_text": "Ayudas agricultura",
  "similarity": 0.87,
  "source": "mock"
}
```

### `/feedback/perfil` (GET)
Ver perfil aprendido de un usuario.

**Query:** `?phone=34XXXXXXXXX`

**Response:**
```json
{
  "ok": true,
  "user": { "id": 123, "name": "Juan" },
  "resumen": "Le han interesado antes: subsector:olivar (+2), provincia:castellón (+1)",
  "tags": [
    { "tag": "subsector:olivar", "score": 2, "positivos": 2, "negativos": 0 }
  ]
}
```

## Testing Local

### Pruebas de Embeddings y Decay
```bash
node tests/embeddings.test.js
# ✅ 24 tests pasados
```

### Pruebas del Parser
```bash
node tests/feedbackParser.test.js
# ✅ 7 tests pasados
```

Todas las pruebas son **locales**: no requieren OpenAI ni Supabase.

## Integración con Digest

El sistema de digest (`src/routes/digest.js`) ahora:

1. **Filtra alertas** por plan + preferencias estáticas
2. **Aplica exclusiones** de `preferencias_extra` 
3. **Ordena por perfil aprendido** usando `ordenarAlertasPorPerfil()`
4. **Genera mensaje IA** con contexto del aprendizaje del usuario

## Próximos Pasos

1. **Embeddings en Producción:** Integrar OpenAI real para similitud semántica avanzada
2. **Ranking por Embeddings:** Usar pgvector en Supabase para buscar alertas similares a intereses del usuario
3. **Feedback Activo:** Enviar confirmaciones cuando el sistema aprende algo nuevo
4. **Dashboard de Aprendizaje:** Panel para que usuarios vean qué ha aprendido el sistema de ellos

## Beneficios

- **Personalización Automática:** El sistema aprende sin que el usuario configure nada manualmente
- **Lenguaje Natural:** Feedback conversacional, no formularios rígidos
- **Mejora Continua:** Cada interacción hace las recomendaciones mejores
- **Escalabilidad:** Funciona para miles de usuarios sin intervención manual

Este sistema transforma Ruralicos de un servicio de alertas genérico a un **asistente inteligente personalizado** que entiende las necesidades específicas de cada agricultor.</content>
<parameter name="filePath">c:\Users\jadri\Desktop\RURALICOS\API\ruralicos-api\docs\sistema_recomendacion_inteligente.md