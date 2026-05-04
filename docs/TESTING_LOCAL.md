# 🧪 Testing Embeddings - Guía Local

## Objetivo

Ejecutar **TODO el código de embeddings LOCALMENTE** sin Supabase, sin OpenAI, sin internet.

Esto te permite:
- ✅ Verificar que la lógica funciona correctamente
- ✅ Probar edge cases sin afectar la BD
- ✅ Iterar rápido (tests ejecutan en <1 segundo)
- ✅ Tener confianza antes de integrar con Supabase

---

## Paso 1: Ejecutar los tests

### Opción A: Con npm (recomendado)

Si el proyecto tiene `tests` en `package.json`:

```bash
npm test
```

O específicamente:

```bash
npm test -- tests/embeddings.test.js
```

### Opción B: Directamente con Node

```bash
node tests/embeddings.test.js
```

### Opción C: Desde VS Code

1. Abre la terminal (Ctrl+`)
2. Escribe:
   ```bash
   cd ruralicos-api
   node tests/embeddings.test.js
   ```
3. Presiona Enter

---

## Qué deberías ver

Si TODO funciona, verás algo así:

```
============================================================
🧪 TEST 1: Generar Embeddings (Mock Local)
============================================================
✅ Embedding tiene 1536 dimensiones
✅ Mismo texto produce idéntico embedding (determinista)
✅ Textos diferentes producen embeddings diferentes

============================================================
🧪 TEST 2: Similitud Coseno
============================================================
✅ (vector consigo mismo = 1.0)
✅ Olivar Castellón vs Olivar Teruel: similitud 0.820 (>0.5)
✅ Olivar vs Porcino: similitud 0.095 (<0.3)

... (más tests) ...

============================================================
🧪 TEST 7: Caso de Uso Realista - Perfil de Usuario
============================================================
✅ Perfil del usuario calculado correctamente
✅ Alerta "Olivar Huesca" es más similar al perfil que "Porcino"
✅ Alerta "Olivar Huesca" es más similar que "Almendro"

📊 Similitudes de candidatas al perfil:
  Olivar en Huesca, agua: 0.873
  Porcino en Zaragoza: 0.128
  Almendro en Palencia: 0.645

============================================================
📈 RESUMEN DE TESTS
============================================================
✅ Tests pasados:  28
❌ Tests fallidos: 0
📊 Total:          28

🎉 ¡TODOS LOS TESTS PASARON!
```

---

## Qué se está probando

### Test 1: Generación de embeddings
- ✅ Generar un embedding (1536 números)
- ✅ Determinismo: mismo texto → mismo embedding
- ✅ Diferencia: textos distintos → embeddings distintos

### Test 2: Similitud coseno
- ✅ Un vector consigo mismo tiene similitud 1.0
- ✅ Textos parecidos: similitud alta
- ✅ Textos diferentes: similitud baja

### Test 3: Centroide (promedio de vectores)
- ✅ Calcular centroide de múltiples embeddings
- ✅ Centroide de vectores iguales = ese vector

### Test 4: Centroide ponderado
- ✅ Algunos embeddings cuentan más que otros
- ✅ Pesos 1,0,0 → centroide ≈ primer embedding

### Test 5: Batch (múltiples embeddings a la vez)
- ✅ Generar múltiples embeddings en una sola llamada
- ✅ Mismo resultado que uno por uno

### Test 6: Decay temporal
- ✅ Feedback reciente: peso 1.0
- ✅ Feedback antiguo: peso bajo
- ✅ Feedback muy viejo (>120 días): casi ignorado

### Test 7: Caso realista
- ✅ Usuario con 3 alertas positivas
- ✅ Calcular su perfil (promedio de embeddings)
- ✅ Buscar alertas similares al perfil
- ✅ Verificar que las alertas relevantes tienen mayor similitud

### Test 8: Visualización
- ✅ Ver tabla de decay temporal

---

## Estructura de archivos

```
ruralicos-api/
├── src/
│   ├── utils/
│   │   ├── embeddings.js     ← NUEVA: Generar/calcular embeddings
│   │   ├── decay.js          ← NUEVA: Decay temporal
│   │   └── ...
│   └── ...
├── tests/
│   ├── embeddings.test.js    ← NUEVO: Tests locales
│   └── ...
└── docs/
    ├── ARQUITECTURA_EMBEDDINGS.md  ← Plan completo
    └── ...
```

---

## Funciones que puedes probar manualmente

Si quieres experimentar, puedes crear un pequeño script:

### Script: `test-manual.js`

```javascript
const { generarEmbedding, similitudCoseno } = require('./src/utils/embeddings');

(async () => {
  // Generar embeddings (mock local)
  const e1 = await generarEmbedding('Olivar en Castellón', true);
  const e2 = await generarEmbedding('Olivar en Teruel', true);
  const e3 = await generarEmbedding('Porcino en Zaragoza', true);

  // Calcular similitudes
  const sim_olivar_olivar = similitudCoseno(e1, e2);
  const sim_olivar_porcino = similitudCoseno(e1, e3);

  console.log(`Olivar vs Olivar: ${sim_olivar_olivar.toFixed(3)}`);
  console.log(`Olivar vs Porcino: ${sim_olivar_porcino.toFixed(3)}`);
})();
```

Ejecutar:
```bash
node test-manual.js
```

---

## Qué NO se prueba aquí (todavía)

Lo que FALTA (se hará en fases posteriores):

- ❌ Integración con OpenAI real (se usa mock)
- ❌ Generación de embeddings en BD (se usa mock local)
- ❌ Guardado en Supabase
- ❌ Búsqueda en la BD con pgvector
- ❌ Endpoint /embeddings/generar-alertas
- ❌ Endpoint /embeddings/actualizar-perfil

---

## Troubleshooting

### Error: "Cannot find module 'src/utils/embeddings'"

**Solución:** Asegúrate de estar en el directorio `ruralicos-api`:
```bash
cd ruralicos-api
node tests/embeddings.test.js
```

### Error: "generarEmbedding is not a function"

**Solución:** Verifica que las funciones están exportadas en `src/utils/embeddings.js`:
```javascript
module.exports = {
  generarEmbedding,
  generarEmbeddingsMatch,
  // ... etc
};
```

### Tests fallan

Si ves `❌ FALLO`, revisa el mensaje. Probablemente hay un bug en la lógica.

**Ejemplo:**
```
❌ FALLO: vector consigo mismo = 1.0
Expected: 1.0
Got: 0.95
```

Esto significaría que el cálculo de similitud coseno tiene un pequeño error.

---

## Próximos pasos (después de que tests pasen)

1. ✅ Tests locales pasan → confianza en la lógica
2. ⏳ Crear endpoints Supabase (POST /embeddings/...)
3. ⏳ Tests con base de datos de prueba
4. ⏳ Desplegar en producción

---

## Notas importantes

- **Mock es 100% determinista:** Mismo texto → idéntico embedding. Esto es bueno para tests pero distinto de OpenAI real.
- **No hay acceso a OpenAI en tests:** Esto es intencional. Así la BD no se carga y los tests son muy rápidos.
- **Embeddings del mock no son "reales":** No useches los números del mock para comparar con OpenAI real. Solo sirven para testing.

---

## Validación final

Cuando todos los tests pasen, sabrás que:

✅ Generación de embeddings funciona  
✅ Similitud coseno funciona  
✅ Centroide funciona  
✅ Decay temporal funciona  
✅ Lógica de batching funciona  
✅ Caso realista funciona  

**Pero aún NO has:**
- Tocado Supabase
- Llamado a OpenAI real
- Generado embeddings de alertas reales
- Integrado con el digest

**Eso viene en la siguiente fase. Primero, que TODO funcione localmente.**

---

**Estado:** 🟢 Tests listos, esperando ejecución local
