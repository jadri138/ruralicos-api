# 🧠 Sistema de Aprendizaje Inteligente Ruralicos

## ¿Qué es?

Un sistema que **entiende lo que dices en español** y **aprende de tus preferencias automáticamente**.

**ANTES:** Tenías que escribir `+1` o `-2`  
**AHORA:** Puedes escribir lo que quieras en español normal

---

## 📖 Ejemplos de uso

### Ejemplo 1: Usuario ama el olivar
```
El usuario escribe por WhatsApp: "Me encanta el olivar en Castellón"
                                              ↓
El sistema entiende: "Positivo (le encanta) → olivar, Castellón"
                                              ↓
El sistema aprende: olivar: +1, Castellón: +1
                                              ↓
Próximas alertas sobre olivar en Castellón → más probable que aparezcan en el digest
```

### Ejemplo 2: Usuario rechaza porcino
```
El usuario escribe: "No me interesa nada de porcino"
                                     ↓
El sistema entiende: "Negativo (no le interesa) → porcino"
                                     ↓
El sistema aprende: porcino: -1
                                     ↓
Próximas alertas sobre porcino → se excluyen del digest
```

### Ejemplo 3: Usuario es específico
```
El usuario escribe: "Ayudas para trigo en Palencia, pero sin normativa"
                                     ↓
El sistema entiende: 
  - Positivo: ["ayudas", "trigo", "palencia"]
  - Negativo: ["normativa"]
                                     ↓
El sistema aprende: 
  - ayudas: +1, trigo: +1, palencia: +1
  - normativa: -1
```

---

## 🔧 ¿Cómo funciona internamente?

### Las 3 funciones principales:

#### 1. **`entenderIntencionUsuario(texto)`**
- **Qué hace:** Lee lo que escribiste y pregunta a ChatGPT "¿Qué quiso decir?"
- **Respuesta:** "positivo", "negativo" o "neutral"
- **Confianza:** 0-1 (cuán seguro está)

#### 2. **`extraerMencionesPosNeg(texto)`**
- **Qué hace:** Busca palabras clave en tu mensaje
- **Busca:** olivar, porcino, Castellón, ayudas, normativa, etc.
- **Respuesta:** Lista de palabras que mencionaste

#### 3. **`analizarFeedbackCompleto(texto)` ← LA FUNCIÓN MAESTRA**
- **Qué hace:** Combina 1 y 2, da un resumen completo
- **Respuesta:**
  ```
  {
    sentimiento: 'positivo',
    aprende_positivo: ['olivar', 'castellón'],
    aprende_negativo: ['porcino'],
    confianza: 0.92,
    es_valido: true
  }
  ```

---

## 📊 ¿Dónde se guarda el aprendizaje?

En la tabla **`user_interest_profile`** de Supabase:

| user_id | tag | score | positivos | negativos |
|---------|-----|-------|-----------|-----------|
| 5 | olivar | +3 | 5 | 0 |
| 5 | porcino | -2 | 0 | 4 |
| 5 | castellón | +2 | 3 | 1 |
| 5 | normativa | -1 | 0 | 2 |

**`score`** = el "peso" que tiene ese tema para este usuario
- Positivo = le interesa
- Negativo = no le interesa
- Se calcula: score = (número de "me gusta") - (número de "no me gusta")

---

## 🧪 Test: Prueba el sistema

### Via WhatsApp (cuando llegue un digest)
```
Usuario recibe digest, contesta:
"Me interesa el olivar pero no el porcino"
                    ↓
Sistema aprende:
- olivar: +1
- porcino: -1
                    ↓
Sistema responde:
"✅ He entendido:
😊 Te interesan: olivar
🚫 No te interesan: porcino
Seguiré aprendiendo"
```

### Vía API (para testing)
```bash
curl -X GET "http://localhost:3000/feedback/simular-respuesta?phone=34XXXXXXXXX&texto=Me%20encanta%20el%20olivar&token=TU_CRON_TOKEN"
```

Respuesta:
```json
{
  "ok": true,
  "user_id": 5,
  "sentimiento": "positivo",
  "confianza": 0.92,
  "aprendizajes_positivos": 1,
  "aprendizajes_negativos": 0,
  "temas_mencionados": ["olivar"]
}
```

### Ver el aprendizaje acumulado de un usuario
```bash
curl -X GET "http://localhost:3000/feedback/perfil?phone=34XXXXXXXXX&token=TU_CRON_TOKEN"
```

Respuesta:
```json
{
  "ok": true,
  "user": { "id": 5, "phone": "34XXXXXXXXX", "name": "Juan" },
  "resumen": "Le han interesado antes: olivar (+3), castellón (+2)...",
  "tags": [
    { "tag": "olivar", "score": 3, "positivos": 5, "negativos": 0 },
    { "tag": "porcino", "score": -2, "positivos": 0, "negativos": 4 }
  ]
}
```

---

## 🔮 Lo que viene después

Aunque por ahora estamos aquí, el plan es:

1. **✅ HECHO:** Sistema aprende de lenguaje natural
2. ⏳ **PRÓXIMO:** Usar embeddings (vectores) para buscar por similitud semántica
3. ⏳ **LUEGO:** Generar digests basados en similitud (las alertas que MÁS te interesan)

---

## 🐛 Debugging: Ver qué está aprendiendo el sistema

### Endpoint de diagnóstico
```bash
curl -X GET "http://localhost:3000/feedback/diagnostico?phone=34XXXXXXXXX&token=TU_CRON_TOKEN"
```

Te muestra:
- Últimos digests enviados al usuario
- Feedback guardado
- Perfil de intereses
- Eventos del webhook (para ver qué recibió el sistema)

---

## ⚠️ Casos especiales

### ¿Qué pasa si el usuario escribe algo que el sistema NO entiende?
```
Usuario: "bueno"
Sistema: confianza: 0.2 → ignorado (es muy vago)
Respuesta: "No he entendido bien, ¿podrías ser más específico?"
```

### ¿Qué si no menciona temas específicos?
```
Usuario: "Me gusta"
Sistema: sentimiento: positivo, pero sin temas claros
Respuesta: Se guarda el sentimiento general, no aprende temas específicos
```

### ¿Qué si el usuario rechaza TODO?
```
Usuario: "Nada de esto me interesa"
Sistema: sentimiento: negativo, aprende_negativo: [todas las palabras mencionadas]
```

---

## 📝 Notas técnicas

- **Confianza < 0.3:** Se ignora (muy poco claro)
- **Confianza 0.3-0.7:** Se procesa con prudencia
- **Confianza > 0.7:** Se aprende con confianza alta

---

**Estado:** ✅ Sistema base de aprendizaje implementado
**Siguiente paso:** Integrar con embeddings vectoriales para búsqueda semántica
