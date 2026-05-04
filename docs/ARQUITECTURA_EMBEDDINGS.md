# 🏗️ Arquitectura de Embeddings Vectoriales - Ruralicos

## Propósito
Transformar el sistema de aprendizaje de **keywords puntuales** a **similitud semántica profunda**.

---

## 📚 Conceptos básicos (sin jerga)

### ¿Qué es un "embedding"?
Un embedding es una **lista de números** que representa el **SIGNIFICADO** de un texto.

**Ejemplo:**
```
Texto: "Olivar en Castellón con riego"
Embedding: [0.12, -0.45, 0.89, 0.03, ..., 0.67]  ← 1536 números
           (1536 dimensiones)
```

Dos textos similares tienen embeddings parecidos:
```
"Olivar en Castellón"      → [0.12, -0.45, 0.89, ...]
"Olivar en Teruel"          → [0.11, -0.47, 0.88, ...]  ← Muy parecido
"Ganadería porcina"         → [0.92, 0.23, -0.34, ...]  ← Muy diferente
```

### ¿Cómo se mide similitud?
Con **similitud coseno** (un número entre -1 y 1):
```
similitud("Olivar Castellón", "Olivar Teruel") = 0.98  ← Muy similar
similitud("Olivar Castellón", "Porcino")        = 0.12  ← Muy diferente
```

---

## 🔄 Flujo del sistema (visión global)

```
┌─────────────────────────────────────────┐
│  ALERTA NUEVA entra al sistema          │
└──────────────────┬──────────────────────┘
                   ↓
         ┌─────────────────────┐
         │  Generar embedding  │ ← Llamar a OpenAI API
         │  de la alerta       │   (1536 números)
         └──────────┬──────────┘
                    ↓
         ┌─────────────────────┐
         │  Guardar en BD:     │
         │  alertas.embedding  │
         └──────────┬──────────┘
                    ↓
          ALERTA LISTA PARA BÚSQUEDA
          
              ↓↓↓

USUARIO RESPONDE CON FEEDBACK
         ↓
┌──────────────────────────────────────────┐
│  Sistema aprende temas (YA EXISTE)       │
│  Sistema aprende SIMILITUD (NUEVO)       │
└─────────────────┬───────────────────────┘
                  ↓
     ┌────────────────────────────────────┐
     │  1. Recopilar alertas que le gustó │
     │     (feedback positivo)             │
     └──────────────┬─────────────────────┘
                    ↓
     ┌────────────────────────────────────┐
     │  2. Tomar embeddings de esas       │
     │     alertas (ya guardados)         │
     └──────────────┬─────────────────────┘
                    ↓
     ┌────────────────────────────────────┐
     │  3. Calcular PROMEDIO de esos      │
     │     embeddings (centroide)         │
     │                                     │
     │  perfil_embedding = media(         │
     │    embedding_alerta_1,             │
     │    embedding_alerta_2,             │
     │    embedding_alerta_3              │
     │  )                                  │
     └──────────────┬─────────────────────┘
                    ↓
     ┌────────────────────────────────────┐
     │  4. Guardar en BD:                 │
     │  users.perfil_embedding            │
     └──────────────┬─────────────────────┘
                    ↓
        PERFIL DEL USUARIO LISTO
        
              ↓↓↓

GENERAR NUEVO DIGEST
        ↓
┌───────────────────────────────────────────┐
│  1. Recuperar perfil_embedding del user   │
│  2. Buscar TOP 5-7 alertas MÁS SIMILARES  │
│     (similitud coseno vs perfil)          │
│  3. Filtrar por restricciones duras:      │
│     - Provincia (si especificó)           │
│     - Tipo de alerta (si especificó)      │
│  4. Ordenar por similitud                 │
│  5. Enviar top 5-7                        │
└──────────────────────────────────────┬───┘
                                       ↓
              USUARIO RECIBE DIGEST ULTRARRELEVANTE
```

---

## 💾 Cambios en la base de datos

### 1. Tabla `alertas` - Añadir columna
```sql
ALTER TABLE alertas 
ADD COLUMN embedding vector(1536) NULL,
ADD COLUMN embedding_generated_at timestamptz NULL;
```

**Para qué sirve:**
- `embedding` = vector de 1536 dimensiones con el significado de la alerta
- `embedding_generated_at` = timestamp para saber cuándo se generó

### 2. Tabla `users` - Añadir columnas
```sql
ALTER TABLE users 
ADD COLUMN perfil_embedding vector(1536) NULL,
ADD COLUMN perfil_embedding_updated_at timestamptz NULL,
ADD COLUMN perfil_embedding_version smallint DEFAULT 0;
```

**Para qué sirve:**
- `perfil_embedding` = promedio ponderado de alertas que le gustaron
- `perfil_embedding_updated_at` = última vez que se actualizó
- `perfil_embedding_version` = número de versión (para tracking de cambios)

### 3. Índice para búsqueda rápida
```sql
CREATE INDEX idx_alertas_embedding 
ON alertas USING ivfflat (embedding vector_cosine_ops) 
WITH (lists = 100);
```

**Para qué sirve:** Búsqueda rápida de alertas similares (sin esto, buscar es muy lento)

---

## 🛠️ Funciones que vamos a crear

### 1. **`generarEmbedding(texto)`** (utils/embeddings.js)
- **Entrada:** Un texto (título + resumen de una alerta)
- **Salida:** Array de 1536 números
- **Llamada a:** OpenAI API (text-embedding-3-small)
- **Coste:** $0.02 por 1M tokens (baratísimo)

```javascript
// Pseudo-código
async function generarEmbedding(texto) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texto.slice(0, 8000),
  });
  return response.data[0].embedding;  // Array[1536]
}
```

### 2. **`procesarEmbeddingsAlertasNuevas()`** (routes/embeddings.js)
- **Qué hace:** Busca alertas sin embedding y las genera
- **Idempotencia:** Solo procesa donde `embedding IS NULL`
- **Batching:** De 50 en 50 para no saturar OpenAI
- **Logs:** Progreso + errores + coste

```javascript
// Pseudo-código
async function procesarEmbeddingsAlertasNuevas() {
  const alertas = await supabase
    .from('alertas')
    .select('id, titulo, resumen_final')
    .is('embedding', null)
    .limit(1000);
    
  for (let i = 0; i < alertas.length; i += 50) {
    const lote = alertas.slice(i, i + 50);
    // Generar embeddings en paralelo
    // Guardar en BD
    // Log progreso
  }
}
```

### 3. **`actualizarPerfilUsuario(userId)`** (routes/embeddings.js)
- **Qué hace:** Calcula el embedding del perfil de un usuario
- **Basado en:** Alertas con feedback positivo (valor = 1)
- **Ponderación:** Decay temporal (feedback antiguo pesa menos)
- **Idempotencia:** Seguro llamar varias veces

```javascript
// Pseudo-código
async function actualizarPerfilUsuario(userId) {
  // 1. Traer feedback positivo del usuario
  const feedbackPositivo = await supabase
    .from('alerta_feedback')
    .select('alerta_id, created_at')
    .eq('user_id', userId)
    .eq('valor', 1);
    
  // 2. Traer embeddings de esas alertas
  const alertas = await supabase
    .from('alertas')
    .select('embedding')
    .in('id', feedbackPositivo.map(f => f.alerta_id));
    
  // 3. Calcular promedio ponderado (decay temporal)
  const perfilEmbedding = calcularCentroideConDecay(alertas, feedbackPositivo);
  
  // 4. Guardar en users.perfil_embedding
  await supabase.from('users')
    .update({ 
      perfil_embedding: perfilEmbedding,
      perfil_embedding_updated_at: now()
    })
    .eq('id', userId);
}
```

### 4. **`buscarAlertasSimilares(userId, fechaBase)`** (routes/embeddings.js)
- **Qué hace:** Busca top 5-7 alertas más similares al perfil del usuario
- **Filtros duros:** Provincia, tipo de alerta (del sistema antiguo)
- **Ordering:** Por similitud coseno

```javascript
// Pseudo-código
async function buscarAlertasSimilares(userId, fechaBase) {
  const user = await supabase.from('users')
    .select('perfil_embedding, preferences')
    .eq('id', userId)
    .single();
    
  const alertas = await supabase.rpc('buscar_alertas_similares', {
    perfil_vector: user.perfil_embedding,
    fecha: fechaBase,
    provincias: user.preferences.provincias,
    tipos_alerta: user.preferences.tipos_alerta,
    limit: 7
  });
  
  return alertas; // Ordenadas por similitud
}
```

---

## 🧪 Testing local (sin Supabase)

Para que puedas probar TODO localmente ANTES de tocar la BD:

### 1. Mock de OpenAI (para testing)
```javascript
// utils/embeddings.test.js
// Simular que OpenAI devuelve embeddings
const mockEmbedding = () => {
  return Array(1536).fill(0).map(() => Math.random() - 0.5);
};
```

### 2. Mock de Supabase (para testing)
```javascript
// Simular guardar/leer de BD
const mockSupabase = {
  from: () => ({
    select: () => ({ data: [], error: null }),
    update: () => ({ error: null }),
  })
};
```

### 3. Script de testing
```bash
npm run test:embeddings
# Prueba:
# - Generar embedding (mock)
# - Calcular similitud
# - Centroide con decay temporal
# - TODO sin tocar la BD real
```

---

## 📋 Plan de implementación (SIN prisas, SIN errores)

### FASE A: Infraestructura de utilidades (sin BD)
1. ✅ `utils/embeddings.js` - Función para generar embeddings
2. ✅ `utils/similarity.js` - Función para calcular similitud coseno
3. ✅ `utils/decay.js` - Función para decay temporal
4. ✅ Tests locales (mocks)

### FASE B: Integración con Supabase (prueba en BD de test)
5. SQL migrations (documentadas, sin ejecutar aún)
6. `routes/embeddings.js` - Endpoints para generar/actualizar
7. Testing en dev

### FASE C: Integración con digest (reemplazar lógica de ranking)
8. Modificar digest.js para usar similitud
9. Testing end-to-end

### FASE D: Cron y automation
10. Llamar a endpoints automáticamente
11. Monitoreo

---

## ⚡ Velocidad de implementación

Cada fase es **independiente y testeable**:
- Fase A: 4-6 horas (todo local, sin BD)
- Fase B: 3-4 horas (con BD de test)
- Fase C: 2-3 horas (integración)
- Fase D: 1-2 horas (cron)

**Total: 10-15 horas, pero sin riesgos**

---

## 🎯 Garantías de calidad

1. **Idempotencia:** Todos los endpoints pueden ejecutarse N veces sin duplicar
2. **Testing local:** No tocamos Supabase hasta tener tests verdes
3. **Logging detallado:** Poder debuggear qué pasó
4. **Rollback fácil:** Si algo falla, volvemos atrás
5. **Zero downtime:** Preferencias estáticas siguen funcionando durante transición

---

## 📝 Notas de desarrollo

- No generar embeddings de alertas PASADAS (4.8K). Solo futuras.
- Cada nueva alerta → embedding automático
- Cada feedback positivo → recalcular perfil del usuario
- Verificar coste OpenAI (estimado: $0.05/mes)
- Monitoriar latencia de búsqueda (debe ser <500ms)

---

**ESTADO:** 🏗️ Diseño arquitectónico completo, listo para implementación ordenada
