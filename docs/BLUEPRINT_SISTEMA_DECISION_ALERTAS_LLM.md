# Blueprint del sistema de decisión de alertas de Ruralicos

> **Estado:** propuesta de diseño; no describe una funcionalidad ya implementada.
>
> **Fecha de referencia:** 1 de agosto de 2026.
>
> **Alcance:** empieza cuando una alerta ya existe en Ruralicos. Incluye
> clasificación, comprensión, personalización, decisión, resumen, envío,
> entrega y aprendizaje en `ruralicos-api`.
>
> **Fuera de alcance:** scrapers, descarga y descubrimiento de boletines,
> captura de documentos, fuentes, rutas de scraping, programación de scrapers y
> cualquier cambio en `src/modules/boletines/`.
>
> **Importante:** la creación de este documento no modifica código, base de
> datos, configuración ni comportamiento de producción.

---

## 0. Cómo usar este documento en una conversación nueva

Este documento está pensado para adjuntarlo completo a una conversación de
Codex sin depender del historial anterior.

### Texto listo para copiar

```text
Lee completamente BLUEPRINT_SISTEMA_DECISION_ALERTAS_LLM.md antes de actuar.

Quiero implementar en ruralicos-api el sistema propuesto en ese documento.
El documento es una propuesta, no una descripción de lo que ya funciona.

Antes de modificar nada:
1. lee AGENTS.md y las instrucciones del workspace;
2. consulta Graphify;
3. contrasta cada propuesta con el código, tests y esquema actuales;
4. prepara una matriz: ya existe / existe parcialmente / falta / debe retirarse;
5. no crees un segundo cron, un segundo pipeline ni motores paralelos;
6. no modifiques scrapers, fuentes, captura de documentos, rutas de boletines ni
   nada bajo src/modules/boletines/; trata la alerta ya creada como entrada;
7. reutiliza y simplifica los componentes actuales del procesamiento de alertas;
8. no supongas columnas de Supabase que no hayas verificado;
9. conserva la provincia y la evidencia como barreras no negociables;
10. trabaja por bloques, prueba cada bloque y realiza una validación completa;
11. la activación final será conjunta, pero antes debe existir una reproducción
    offline de casos históricos que no envíe mensajes reales.

Explícame los avances en español sencillo y breve. No me hagas revisar alertas
manualmente una a una. No borres compatibilidad externa sin demostrar que no se
utiliza. No consideres que un HTTP 200 equivale a un WhatsApp entregado.
```

### Orden de lectura recomendado

Si se necesita una orientación rápida:

1. leer el resumen ejecutivo;
2. leer las decisiones de diseño no negociables;
3. leer la arquitectura objetivo;
4. leer el mapa hacia Ruralicos actual;
5. seguir los paquetes de implementación;
6. utilizar los criterios de aceptación como definición de terminado.

---

## 1. Resumen ejecutivo

Ruralicos necesita decidir qué información oficial merece llegar a cada
persona. No es solamente un clasificador de textos y tampoco debe convertirse
en un chatbot que envía aquello que «le parece interesante».

La arquitectura recomendada es híbrida:

```text
ALERTA YA CREADA + EVIDENCIA YA CAPTURADA
      ↓
FICHA DE HECHOS CON EVIDENCIA
      ↓
BARRERAS DE ELEGIBILIDAD
      ↓
GENERACIÓN DE CANDIDATAS
      ↓
RANKING DETERMINISTA BARATO
      ↓
LLM VALORADOR USUARIO-ALERTA
      ↓
AUTORIDAD FINAL DETERMINISTA
      ↓
CONTROLADOR DE COMUNICACIONES
      ↓
WHATSAPP Y CONFIRMACIÓN DE ENTREGA
      ↓
APRENDIZAJE Y MEDICIÓN
```

El LLM debe aportar comprensión semántica y valoración contextual. No debe
controlar por sí solo el territorio, la evidencia, la frecuencia ni la entrega.

La decisión no será un simple «sí/no». Cada pareja usuario-alerta terminará en
uno de estos estados:

| Estado | Significado |
| --- | --- |
| `SEND_NOW` | Aviso excepcional, verificable y realmente urgente |
| `ADD_TO_DIGEST` | Incluir en el próximo resumen del usuario |
| `HOLD_FOR_EVIDENCE` | Falta información esencial; reintentar automáticamente |
| `DROP` | No aporta suficiente utilidad, está repetida o no es aplicable |
| `BLOCKED` | Incumple una barrera dura; ninguna puntuación puede rescatarla |

La mayor mejora no consiste en añadir más modelos. Consiste en que todas las
capas utilicen una misma ficha de alerta, un mismo perfil de usuario, un mismo
contrato de decisión y una misma traza auditable.

### 1.1 Límite funcional

Este blueprint no intenta mejorar cómo se localiza o descarga una publicación.
El sistema recibe como entrada las alertas, documentos, enlaces y metadatos que
el proceso actual ya haya almacenado. Si esa entrada es insuficiente, la alerta
se retiene y se registra la causa; este proyecto no modifica el scraper para
completarla.

Quedan expresamente excluidos:

- `src/modules/boletines/`;
- scrapers estatales, autonómicos y provinciales;
- configuración de fuentes complementarias;
- rutas `/scrape-*`;
- horarios o ejecución de scrapers;
- tablas y métricas específicas de captura como objeto de rediseño;
- cambios de proveedor o técnica de descarga.

El punto inicial es: **«la alerta ya está en la base de datos; ahora hay que
entenderla y decidir si se envía a una persona»**.

---

## 2. Problema que se quiere resolver

### 2.1 Pregunta de negocio

Para cada persona y cada alerta, Ruralicos debe responder:

> ¿Esta información oficial es aplicable, útil y suficientemente fiable para
> ocupar la atención limitada de esta persona en este momento?

La respuesta debe considerar simultáneamente:

- territorio;
- actividad y situación del usuario;
- beneficiarios y requisitos de la convocatoria;
- actualidad y plazo;
- posibilidad de realizar una acción;
- calidad y procedencia de la evidencia;
- preferencias expresas;
- aprendizaje procedente de respuestas y acciones;
- repetición y fatiga;
- historial de comunicaciones;
- coste de equivocarse enviando;
- coste de equivocarse guardando silencio.

### 2.2 Los dos errores principales

**Falso positivo:** se envía algo que no corresponde o no sirve. Reduce la
confianza, aumenta el cansancio y puede provocar una baja.

**Falso negativo:** se pierde una ayuda, obligación o plazo que sí era útil. En
Ruralicos este error también es grave; un sistema excesivamente conservador que
nunca envía no cumple su función.

El diseño debe equilibrar ambos errores. «No inventar» no puede significar
«bloquear todo».

### 2.3 Lo que significa calidad

El objetivo no es maximizar clics. Una alerta puede ser muy útil aunque el
usuario lea el resumen y no pulse el enlace. La métrica principal debe acercarse
a «utilidad real sin molestias», no a «interacción».

---

## 3. Decisiones de diseño no negociables

1. **La geografía es una barrera, no un premio de puntuación.**
2. **Cada afirmación importante debe apuntar a evidencia oficial.**
3. **Los embeddings recuperan candidatas; no autorizan envíos.**
4. **El LLM valora utilidad, pero no puede saltarse las políticas.**
5. **Las preferencias expresas prevalecen sobre inferencias de comportamiento.**
6. **Un clic es una señal débil; una respuesta explícita es fuerte.**
7. **Un rechazo concreto no debe convertirse en una exclusión global.**
8. **No se envía contenido para rellenar una cuota.**
9. **Una respuesta del proveedor no equivale a entrega al teléfono.**
10. **Cada decisión debe explicar por qué ocurrió y qué la bloqueó.**
11. **No habrá revisión humana diaria alerta por alerta.**
12. **No se construirá otro pipeline paralelo.**
13. **Los fallos opcionales no deben detener un envío seguro ya preparado.**
14. **Los fallos de evidencia sí deben impedir afirmaciones no verificadas.**
15. **Los datos enviados al proveedor de IA serán los mínimos necesarios.**

---

## 4. Investigación externa y lecciones aplicables

### 4.1 Google y YouTube: varias fases con responsabilidades distintas

Google presenta una arquitectura habitual de recomendación formada por
generación de candidatas, puntuación y reordenación final. La última fase aplica
restricciones como actualidad, diversidad o eliminación de contenido no
deseado.

Aplicación a Ruralicos:

- las reglas y los embeddings producen candidatas;
- un ranking común permite comparar candidatas de diferentes orígenes;
- el LLM añade valoración contextual sobre un conjunto pequeño;
- el controlador final aplica territorio, seguridad, diversidad y frecuencia.

Google también advierte que optimizar únicamente clics puede conducir a
resultados de baja calidad. Ruralicos debe optimizar utilidad, confianza y
acciones útiles.

Fuentes:

- [Recommendation systems overview](https://developers.google.com/machine-learning/recommendation/overview/types)
- [Candidate generation](https://developers.google.com/machine-learning/recommendation/overview/candidate-generation)
- [Scoring](https://developers.google.com/machine-learning/recommendation/dnn/scoring)
- [Re-ranking](https://developers.google.com/machine-learning/recommendation/dnn/re-ranking)
- [Rules of Machine Learning](https://developers.google.com/machine-learning/guides/rules-of-ml/)

### 4.2 LinkedIn: un controlador central de notificaciones

LinkedIn describe un «Air Traffic Controller» que conoce las preferencias, el
historial de notificaciones, las interacciones y la carga reciente de cada
miembro. Filtra duplicados, contenido caducado y exceso de comunicaciones. Sus
modelos pueden decidir entre descartar, mostrar dentro de la aplicación o enviar
una notificación.

Esta es la referencia empresarial más próxima al problema de Ruralicos.

Aplicación:

- todas las comunicaciones compiten antes del envío;
- se elige un conjunto, no cada alerta aisladamente;
- se controla la fatiga en un único lugar;
- se conoce qué se envió anteriormente;
- se evita que distintos módulos envíen por separado al mismo usuario.

LinkedIn también separa la generación de destinatarios y la puntuación de cada
pareja contenido-persona antes de pasarla al controlador de comunicaciones.

Fuentes:

- [Air Traffic Controller: Member-First Notifications](https://www.linkedin.com/blog/engineering/messaging-notifications/air-traffic-controller-member-first-notifications-at-linkedin)
- [Concourse: Personalized Content Notifications](https://www.linkedin.com/blog/engineering/messaging-notifications/concourse-generating-personalized-content-notifications-in-near)
- [Learning Hiring Preferences](https://www.linkedin.com/blog/engineering/learning/learning-hiring-preferences-the-ai-behind-linkedin-jobs)

### 4.3 Netflix: memoria central y comportamiento temporal

Netflix combina las preferencias iniciales con el historial de interacción y da
más peso a señales recientes. En 2025 explicó su avance hacia un modelo central
de recomendación inspirado en la arquitectura de los grandes modelos de
lenguaje para reducir la proliferación de modelos especializados.

Ruralicos no dispone de la escala de Netflix y no necesita entrenar un modelo
fundacional propio. Sí debe copiar dos ideas:

- una representación central y coherente del usuario;
- una secuencia temporal donde las acciones recientes importan más sin borrar
  las preferencias estables.

Fuentes:

- [How Netflix’s Recommendations System Works](https://help.netflix.com/en/node/100639)
- [Foundation Model for Personalized Recommendation](https://netflixtechblog.com/foundation-model-for-personalized-recommendation-1a0bd8e02d39)

### 4.4 DoorDash: LLM para comprender; ranking para decidir

DoorDash ha descrito sistemas donde el LLM transforma señales de comportamiento
en memoria semántica legible, genera perfiles y crea consultas o agrupaciones
personalizadas. Esas representaciones alimentan después sus modelos de
recuperación y ranking.

La lección importante no es «el LLM sustituye al recomendador», sino:

> el LLM convierte información dispersa en significado; las capas de selección
> y política siguen controlando qué se muestra o envía.

DoorDash también utiliza exploración controlada para descubrir intereses nuevos,
pero siempre dentro de los elementos realmente disponibles o aplicables.

Fuentes:

- [Unified consumer memory for personalization](https://careersatdoordash.com/blog/doordash-unified-consumer-memory-for-personalization-at-scale/)
- [Profile Generation with LLMs](https://careersatdoordash.com/blog/doordash-profile-generation-llms-understanding-consumers-merchants-and-items/)
- [Exploitation and Exploration](https://careersatdoordash.com/blog/homepage-recommendation-with-exploitation-and-exploration/)
- [LLMs for relevance labels](https://careersatdoordash.com/blog/unleashing-the-power-of-large-language-models-at-doordash-for-a-seamless-shopping-adventure/)

### 4.5 OpenAI y NIST: un juez automático también debe evaluarse

Un modelo que puntúa respuestas puede ayudar a automatizar evaluaciones, pero no
se debe asumir que su resultado es verdad. OpenAI ha publicado que sus graders
automáticos son útiles para escalar evaluaciones, pero no siempre alcanzan la
fiabilidad de evaluadores expertos. NIST recomienda medir, documentar y gestionar
riesgos durante todo el ciclo de vida.

Ruralicos no necesita revisión humana diaria. Necesita:

- un corpus histórico de regresión;
- reglas exactas para los hechos comprobables;
- comparación periódica entre modelos;
- alertas automáticas ante anomalías;
- trazabilidad suficiente para investigar los pocos casos graves.

Fuentes:

- [OpenAI: Measuring performance on real-world tasks](https://openai.com/index/gdpval/)
- [OpenAI Graders](https://platform.openai.com/docs/api-reference/graders)
- [NIST AI Risk Management Framework](https://airc.nist.gov/airmf-resources/airmf/)

### 4.6 UltraMsg y Twilio: el envío tiene un ciclo de vida

UltraMsg permite activar eventos de confirmación mediante
`webhook_message_ack`, incluyendo entrega y lectura. Twilio documenta la misma
idea con estados separados como queued, sent, delivered, read y failed.

Ruralicos debe saber diferenciar aceptación por el proveedor, entrega al
dispositivo y lectura. Esta separación es necesaria para investigar «no se ha
enviado nada» sin confundir un fallo de selección con un fallo de transporte.

Fuentes:

- [UltraMsg instance settings](https://docs.ultramsg.com/api/post/instance/settings)
- [UltraMsg delivery and read ACK](https://medium.com/@ultramsg/check-whatsapp-message-delivery-read-status-ack-26403d3e6f5e)
- [Twilio outbound status callbacks](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks)

---

## 5. Arquitectura objetivo

### 5.1 Vista completa

```text
[A] ALERTA DISPONIBLE
    alerta, texto, documentos y metadatos ya almacenados
              ↓
[B] COMPRENSIÓN DE ALERTA
    ficha única + evidencia + confianza
              ↓
[C] ELEGIBILIDAD DURA
    geografía, vigencia, identidad, exclusiones, evidencia mínima
              ↓
[D] GENERADORES DE CANDIDATAS
    matching exacto + embeddings + intereses aprendidos + descubrimiento seguro
              ↓
[E] PRE-RANKING
    score barato y explicable; top K por usuario
              ↓
[F] JUEZ LLM PERSONAL
    aplicabilidad, utilidad, acción, novedad y dudas
              ↓
[G] AUTORIDAD FINAL
    hechos, política, fatiga, diversidad, duplicados e idempotencia
              ↓
[H] MENSAJE
    bloques breves derivados de hechos aprobados
              ↓
[I] ENTREGA
    cola, proveedor, ACK, reintentos y conciliación
              ↓
[J] APRENDIZAJE
    feedback explícito, acciones, decay y actualización del perfil
              ↓
[K] MEDICIÓN
    calidad, cobertura, silencio, entrega, coste y regresiones
```

### 5.2 Separación de responsabilidades

| Capa | Puede decidir | No puede decidir |
| --- | --- | --- |
| Comprensión | Qué afirma el documento y con qué evidencia | A quién enviar |
| Elegibilidad | Qué combinaciones son imposibles | Qué candidata es más interesante |
| Embeddings | Qué elementos son semánticamente próximos | Aplicabilidad legal o territorial |
| Pre-ranking | Orden preliminar comparable | Saltarse bloqueos |
| Juez LLM | Utilidad contextual para una persona | Inventar hechos o ampliar territorio |
| Autoridad final | Permitir o impedir envío | Reescribir hechos sin evidencia |
| Generador de mensaje | Explicar una decisión aprobada | Cambiar la decisión |
| Transporte | Entregar y registrar estado | Elegir contenido |

---

## 6. Contrato canónico de la alerta

### 6.1 Principio

Toda capa debe utilizar la misma ficha. No debe existir una clasificación para
el matcher, otra para el resumen y otra para la validación final.

### 6.2 Contenido conceptual de `AlertTruthCard`

| Grupo | Campos conceptuales |
| --- | --- |
| Identidad | alerta, fuente, documento, publicación, versión |
| Naturaleza | ayuda, obligación, plazo, curso, trámite, resolución, información |
| Beneficiarios | perfiles incluidos, excluidos y condiciones |
| Actividad | sectores, subsectores, cultivos, especies y figuras jurídicas |
| Territorio | nivel, comunidades, provincias, municipios y alcance nacional |
| Acción | solicitar, justificar, subsanar, alegar, inscribirse, informarse |
| Tiempo | publicación, apertura, cierre, vigencia y caducidad |
| Valor | beneficio, riesgo evitado, coste, cuantía o consecuencia conocida |
| Evidencia | fragmento, URL, documento, localización y confianza por campo |
| Riesgo | expediente individual, dato personal, texto incompleto, contradicción |
| Estado | listo, incompleto, revisión automática, bloqueado, caducado |

### 6.3 Evidencia por campo

No basta con decir «la ficha tiene confianza 90». Cada dato crítico debe conocer
su evidencia:

- `beneficiarios`: frase oficial que los define;
- `territorio`: encabezado, ámbito o artículo;
- `deadline`: fecha y texto que explican qué vence;
- `action`: trámite respaldado;
- `amount`: cuantía y contexto;
- `official_url`: origen canónico.

### 6.4 Confianza útil

La confianza debe reflejar disponibilidad y consistencia de evidencia, no la
seguridad verbal del LLM.

Niveles:

- `verified`: evidencia clara y coherente;
- `supported`: evidencia suficiente, pero con detalle no esencial incompleto;
- `uncertain`: falta un hecho necesario o hay contradicción;
- `unsupported`: el dato no aparece en la fuente;
- `not_applicable`: el campo no corresponde a esa alerta.

### 6.5 Qué debe bloquear y qué no

Para evitar un sistema que nunca envía:

- un plazo no verificado impide afirmar urgencia, pero no necesariamente enviar
  una información general útil;
- una cuantía ausente no bloquea una convocatoria si el resto está verificado;
- un municipio ausente bloquea un expediente individual, pero no una ayuda
  general de ámbito provincial;
- una acción poco clara puede convertir `SEND_NOW` en `ADD_TO_DIGEST`;
- territorio o beneficiario esenciales sin resolver llevan a
  `HOLD_FOR_EVIDENCE`.

---

## 7. Contrato canónico del usuario

### 7.1 Capas del perfil

El perfil no debe ser un único texto ni un único vector. Debe separar:

1. **Identidad operativa:** territorio, actividad, plan y canal.
2. **Preferencias declaradas:** intereses, exclusiones y frecuencia.
3. **Memoria explícita:** necesidades expresadas conversando.
4. **Comportamiento observado:** clics y uso.
5. **Contexto temporal:** proyectos, campañas o necesidades con caducidad.
6. **Representación semántica:** embeddings positivos y negativos.
7. **Historial de exposición:** qué se mostró, envió, entregó y repitió.

### 7.2 Jerarquía de autoridad

```text
restricción legal o territorial
        ↓
preferencia o exclusión explícita actual
        ↓
respuesta explícita sobre una alerta
        ↓
memoria explícita anterior con vigencia
        ↓
preferencia registrada inicialmente
        ↓
acción fuerte: guardar, solicitar, pedir más
        ↓
clic
        ↓
inferencia estadística o similitud
```

Una señal inferior no puede contradecir silenciosamente a una superior.

### 7.3 Memorias atómicas

Cada aprendizaje debe conservar:

- contenido;
- polaridad;
- ámbito: alerta, tema, subsector, territorio, frecuencia o canal;
- fuerza;
- fuente: respuesta, clic, registro o inferencia;
- fecha;
- caducidad opcional;
- alerta que originó la memoria;
- confianza;
- posibilidad de corrección por el usuario.

Ejemplo:

> «Esta no porque ya la pedí, pero mándame ayudas parecidas»

Debe producir dos aprendizajes distintos:

- convocatoria concreta: conocida/no repetir;
- ayudas del mismo tipo: interés positivo.

Nunca debe producir «no le interesan las ayudas».

### 7.4 Decay temporal

- territorio y actividad declarada son estables hasta que el usuario los cambie;
- exclusiones explícitas permanecen hasta modificación;
- necesidades de campaña pierden fuerza con el tiempo;
- clics pierden fuerza rápidamente;
- respuestas recientes pesan más que señales antiguas;
- una única acción nunca debe reescribir todo el perfil.

### 7.5 Privacidad

El juez LLM no necesita teléfono, nombre completo ni identificadores internos.
Debe recibir un perfil mínimo pseudonimizado. Las conversaciones completas no se
envían si una memoria resumida aporta lo necesario.

---

## 8. Barreras de elegibilidad

### 8.1 Territorio

Reglas:

- exacta provincia o municipio del usuario: permitido;
- convocatoria autonómica que abarca realmente su provincia: permitido;
- convocatoria nacional aplicable: permitido;
- otra provincia: bloqueado;
- provincia inferida solo por una mención incidental: no suficiente;
- fuente autonómica sin ámbito claro: resolver con evidencia, no asumir nacional;
- expediente individual: exigir relación territorial específica.

La exploración nunca amplía geografía.

### 8.2 Vigencia

Bloquear o degradar según el caso:

- plazo cerrado;
- noticia sustituida por una versión posterior;
- convocatoria anulada;
- publicación histórica sin acción actual;
- evento ya celebrado.

### 8.3 Beneficiario y actividad

Una coincidencia de palabras no basta. Debe distinguirse entre:

- afectado directo;
- posible beneficiario;
- profesional que solo debería conocer la norma;
- entidad mencionada sin ser destinataria;
- expediente individual ajeno.

### 8.4 Exclusiones

Las exclusiones expresas son duras cuando su ámbito está claro. Una exclusión
ambigua pasa a interpretación estructurada, no a bloqueo global.

### 8.5 Evidencia y calidad

Una fuente incompleta no siempre implica descarte. Debe ir a recuperación
automática. Solo se bloquea definitivamente cuando:

- se agotaron los intentos razonables;
- la publicación ya no es vigente;
- existe contradicción no resoluble;
- la alerta depende precisamente del dato ausente.

---

## 9. Generación de candidatas

No debe recorrerse el producto cartesiano completo de todas las alertas por todos
los usuarios con llamadas LLM. Se generan candidatas baratas por varias vías:

### 9.1 Vía exacta

- sector;
- subsector;
- tipo de alerta;
- territorio;
- cultivo o especie;
- necesidad declarada.

### 9.2 Vía semántica

Embeddings del perfil contra embeddings de fichas de alerta. La similitud añade
recuperación, no autoridad.

### 9.3 Vía de memoria

Temas positivos recientes, alertas relacionadas con una acción anterior o una
necesidad expresada.

### 9.4 Vía de cobertura segura

Alertas nacionales o autonómicas amplias, verificadas, accionables y relevantes
para la actividad, aunque el usuario aún no haya generado feedback.

### 9.5 Vía de exploración

Como máximo una candidata de descubrimiento por digest y solo si:

- pasa todas las barreras;
- está dentro de la actividad o una relación próxima explicable;
- tiene calidad alta;
- no desplaza una candidata claramente mejor;
- nunca procede de otra provincia.

### 9.6 Unión y deduplicación

Todos los generadores producen IDs y motivos. Se unen, se eliminan duplicados y
se conserva la procedencia de cada candidata para auditoría.

---

## 10. Pre-ranking determinista

### 10.1 Objetivo

Reducir un conjunto potencialmente grande a un top pequeño que el LLM pueda
valorar con coste y latencia controlados.

### 10.2 Dimensiones

- coincidencia declarada;
- calidad de la ficha;
- aplicabilidad territorial;
- beneficiario compatible;
- acción disponible;
- urgencia verificada;
- similitud semántica;
- interés aprendido;
- novedad;
- repetición;
- exposición reciente;
- riesgo de ruido.

### 10.3 Propiedades

- explicable mediante razones y contribuciones;
- determinista para la misma versión de datos;
- versionado;
- ningún bonus anula un bloqueo;
- las puntuaciones de diferentes generadores se normalizan antes de comparar;
- no se optimiza directamente el clic.

### 10.4 Resultado

Por usuario, se envía al juez LLM un top K acotado. K debe ajustarse con datos de
coste y cobertura; conceptualmente puede estar alrededor de 10-20 candidatas,
no centenares.

---

## 11. Juez LLM de relevancia personal

### 11.1 Responsabilidad

Responder a lo que las reglas simples no capturan bien:

- si el usuario parece realmente beneficiario;
- si la información ofrece una acción útil;
- si es demasiado genérica;
- si aporta algo nuevo frente a lo ya enviado;
- si encaja con una necesidad expresada en lenguaje natural;
- si merece atención inmediata, digest o espera;
- qué duda impide tomar una decisión segura.

### 11.2 Entradas mínimas

- ficha verificada de alerta;
- perfil de decisión pseudonimizado;
- coincidencias y bloqueos ya calculados;
- exposiciones recientes relevantes;
- preferencias de frecuencia;
- fecha y contexto temporal;
- política de decisión versionada.

No se debe enviar al modelo:

- la base de datos completa;
- teléfono;
- conversaciones sin filtrar;
- columnas irrelevantes;
- secretos;
- HTML o documentos sin delimitar como datos no confiables.

### 11.3 Salida estructurada conceptual

| Campo | Uso |
| --- | --- |
| `decision` | uno de los estados autorizados |
| `applicability` | posibilidad real de que corresponda al usuario |
| `usefulness` | valor práctico |
| `actionability` | existencia de acción concreta |
| `urgency` | urgencia respaldada, no retórica |
| `novelty` | diferencia frente a envíos recientes |
| `confidence` | confianza operativa, sujeta a calibración |
| `reason_codes` | motivos normalizados |
| `evidence_refs` | campos de la ficha usados |
| `missing_information` | datos que impedirían una decisión superior |
| `user_reason` | explicación breve y natural |
| `message_facts` | hechos permitidos para redactar |

### 11.4 Restricciones del juez

- no puede crear territorios nuevos;
- no puede añadir beneficiarios;
- no puede completar un plazo;
- no puede citar hechos fuera de la ficha;
- no puede reinterpretar una exclusión dura;
- no puede ordenar directamente un envío si hay bloqueos;
- debe abstenerse cuando falta información esencial;
- una confianza expresada por el modelo no reemplaza la evidencia.

### 11.5 Consistencia

Para minimizar variabilidad:

- salida con esquema estricto;
- instrucciones estables y versionadas;
- temperatura o aleatoriedad baja cuando proceda;
- ejemplos de frontera;
- reason codes cerrados más explicación libre corta;
- reintento solo por fallo técnico o estructura inválida;
- no repetir hasta obtener la respuesta deseada.

### 11.6 Segunda opinión

No se usarán dos modelos para todo. Una segunda evaluación se reserva para:

- contradicción entre ficha y juez;
- alerta de alto impacto;
- urgencia extrema;
- beneficiario ambiguo;
- resultado muy próximo al umbral;
- cambio importante de modelo o prompt.

Si dos evaluaciones no concuerdan, el estado es `HOLD_FOR_EVIDENCE` o se aplica
el resultado seguro inferior. No se promedian afirmaciones contradictorias.

---

## 12. Autoridad final de envío

La autoridad final es determinista. Recibe la ficha, la decisión del juez, el
perfil, el historial y la política.

### 12.1 Comprobaciones por candidata

- no existe bloqueo duro;
- la decisión LLM es admisible;
- los hechos usados están verificados o respaldados;
- territorio respaldado;
- estado vigente;
- no enviada anteriormente;
- no incluida dos veces en el mismo portfolio;
- no contradice preferencias actuales;
- el mensaje no añade hechos;
- la idempotencia está garantizada.

### 12.2 Comprobaciones del conjunto

- límite total;
- diversidad temática;
- evitar cinco alertas del mismo trámite;
- prioridad de las más accionables;
- equilibrio entre urgencia y utilidad;
- máximo de una exploración segura;
- frecuencia y horario del usuario;
- ausencia de mensajes ya entregados recientemente;
- tamaño legible del mensaje.

### 12.3 Política de silencio

No se envía si no hay ninguna candidata aprobada. Pero el silencio debe quedar
explicado con un embudo cuantitativo:

```text
alertas disponibles
→ pasan vigencia
→ pasan territorio
→ pasan actividad/beneficiario
→ candidatas
→ valoradas por LLM
→ aprobadas por autoridad final
→ incluidas
→ encoladas
→ entregadas
```

Si existe silencio sistemático durante varios días, se genera una alerta
operativa automática. No se rebaja silenciosamente la provincia ni la evidencia.

---

## 13. Resumen y experiencia del usuario

### 13.1 Estructura de cada alerta

1. título corto centrado en la oportunidad o acción;
2. por qué aparece para esa persona;
3. qué puede obtener, hacer o evitar;
4. fecha límite, solo si está verificada;
5. acción recomendada;
6. enlace oficial.

Ejemplo:

```text
Ayuda para modernizar explotaciones ganaderas

Te aparece porque trabajas con ganado vacuno en Huesca.
Financia determinadas mejoras de instalaciones y el plazo oficial termina el
18 de septiembre.

Qué hacer: comprobar los requisitos y preparar la solicitud.
Fuente oficial: [enlace]
```

### 13.2 Límites de tono

- no prometer que el usuario recibirá una ayuda;
- no decir «te afecta» si solo puede interesarle;
- no inventar urgencia;
- no copiar lenguaje administrativo innecesario;
- no mostrar puntuaciones internas;
- no mencionar «algoritmos», «embeddings» o «fact sheets» al usuario;
- no repetir siempre la misma fórmula;
- conservar enlaces oficiales.

### 13.3 Digest

- un mensaje diario como máximo por defecto;
- entre una y cinco alertas aprobadas;
- ordenadas por acción y plazo, no solo por score;
- no rellenar hasta cinco;
- mostrar primero lo que requiere acción;
- separar claramente las oportunidades de la información preventiva.

### 13.4 Alertas inmediatas

`SEND_NOW` debe ser excepcional. Requiere:

- acción o riesgo temporal real;
- plazo o efecto inmediato verificado;
- alta aplicabilidad personal;
- alta calidad;
- no haber enviado aviso equivalente;
- respeto a las ventanas de descanso salvo gravedad justificada.

La mayoría de publicaciones oficiales debe ir al digest, no interrumpir al
usuario.

---

## 14. Controlador de comunicaciones

### 14.1 Objetivo

Ser el único punto que autoriza comunicaciones automáticas no transaccionales.
Clasificación, MIA, embeddings y feedback no deben enviar directamente por su
cuenta.

### 14.2 Estado necesario

Por usuario:

- comunicaciones recientes;
- tipos y temas enviados;
- alertas conocidas;
- entregas y lecturas;
- respuestas;
- frecuencia configurada;
- horario;
- fatiga estimada;
- mensaje pendiente;
- idempotency keys.

### 14.3 Reglas de portfolio

- una alerta solo puede ocupar una posición;
- avisos equivalentes se agrupan;
- si dos alertas hablan de la misma convocatoria, se elige la mejor fuente;
- una oportunidad fuerte desplaza una exploración;
- un usuario que reduce frecuencia recibe menos, no contenido peor;
- una alerta fallida de entrega no se considera consumida;
- una alerta leída no se reenvía salvo actualización material.

### 14.4 Preguntas de aprendizaje

No se añade una pregunta a todos los mensajes. Se pregunta cuando la respuesta
puede cambiar decisiones futuras y se respeta un límite de frecuencia.

Ejemplos:

- «¿Te interesan también ayudas para maquinaria?»
- «¿Quieres que deje fuera los cursos?»
- «¿Trabajas solo en Huesca o también en Zaragoza?»

Nunca se presupone una ampliación territorial hasta que el usuario la confirme.

---

## 15. Entrega, ACK y conciliación

### 15.1 Máquina de estados

```text
DRAFT
  ↓
APPROVED
  ↓
QUEUED
  ↓
PROVIDER_ACCEPTED
  ├──→ FAILED
  ↓
SENT_TO_WHATSAPP
  ├──→ UNDELIVERED
  ↓
DELIVERED
  ↓
READ
```

### 15.2 Principios

- guardar el ID del proveedor;
- asociar cada intento con digest, usuario y versión del mensaje;
- procesar webhooks de ACK de forma idempotente;
- conservar el orden de estados;
- no convertir un estado antiguo en uno anterior por eventos desordenados;
- registrar código y causa de error;
- reintentar solo fallos reintentables;
- no generar un segundo digest para reintentar transporte;
- conciliar periódicamente estados atascados con el proveedor si es posible.

### 15.3 Qué significa «enviado»

- `PROVIDER_ACCEPTED`: UltraMsg aceptó la petición;
- `DELIVERED`: WhatsApp confirmó llegada al dispositivo;
- `READ`: existe confirmación de lectura;
- la ausencia de `READ` no significa desinterés;
- la ausencia de `DELIVERED` sí es un problema de transporte.

---

## 16. Aprendizaje continuo

### 16.1 Señales explícitas

- respuesta libre;
- preferencia editada;
- «más como esta»;
- «menos de esto»;
- motivo de rechazo;
- cambio de frecuencia;
- necesidad temporal declarada.

### 16.2 Señales implícitas

- clic en enlace;
- apertura si existe ACK de lectura;
- petición de detalle;
- interacción posterior;
- ausencia repetida de interacción, con peso muy bajo.

### 16.3 Pesos relativos

No se fija aquí un número definitivo, pero se impone el orden:

```text
respuesta explícita > edición de preferencias > acción fuerte > clic > lectura > silencio
```

### 16.4 Alcance del feedback negativo

Antes de aplicar un negativo, el parser debe identificar su causa:

- ya conocida;
- no aplicable;
- otro territorio;
- otro subsector;
- no desea ese tipo de trámite;
- demasiado frecuente;
- mal explicada;
- no confía en la fuente;
- no le interesa el tema.

Cada causa actualiza una parte diferente. «Ya la pedí» no penaliza el tema.

### 16.5 Actualización del perfil

- idempotente;
- versionada;
- reversible;
- con límites para evitar cambios bruscos;
- decay temporal;
- separación de memoria positiva y negativa;
- explicación de qué señales formaron el perfil;
- posibilidad de borrar o corregir memoria.

---

## 17. Alertas dudosas sin revisión humana diaria

### 17.1 Cola automática de evidencia

`HOLD_FOR_EVIDENCE` debe activar, utilizando únicamente la información ya
capturada por Ruralicos:

1. identificar los campos esenciales ausentes;
2. releer el texto, documento o PDF que ya esté almacenado;
3. intentar otra estrategia de extracción sobre ese material existente;
4. reconstruir solo los campos necesarios;
5. volver a validar;
6. volver a decidir;
7. caducar el caso cuando deje de ser útil.

Si el material necesario nunca fue capturado, se registra una dependencia
upstream y la alerta permanece retenida o caduca. Resolver esa carencia en los
scrapers queda fuera de este proyecto.

### 17.2 Límites

- máximo de intentos;
- backoff;
- no repetir la misma estrategia sin cambios;
- distinguir fallo técnico de ausencia real de información;
- no convertir timeout en descarte temático;
- no detener todo el cron por una alerta;
- conservar trazabilidad de cada intento.

### 17.3 Resultado final

- evidencia recuperada: vuelve al flujo;
- dato no esencial ausente: degrada la promesa, no necesariamente bloquea;
- dato esencial ausente: no se envía;
- alerta caducada: se cierra;
- anomalía masiva de una fuente: aviso operativo automático.

---

## 18. Resiliencia y degradación controlada

El sistema debe seguir funcionando de forma segura cuando una pieza falla.

| Fallo | Comportamiento recomendado |
| --- | --- |
| Embeddings no disponibles | usar candidatas exactas y de taxonomía |
| LLM extractor no disponible | mantener alertas nuevas en espera; no borrar |
| LLM juez no disponible | enviar solo candidatas deterministas de alta confianza permitidas por política; retener el resto |
| LLM redactor no disponible | plantilla construida desde hechos verificados |
| Evidencia almacenada incompleta | retener, registrar la carencia y no modificar el scraper desde este proyecto |
| Una alerta falla | continuar el lote y registrar el fallo |
| Supabase falla | no marcar etapas como terminadas |
| UltraMsg falla | conservar cola e intento; no regenerar contenido |
| ACK no llega | mantener estado desconocido y conciliar |
| Cron se reinicia | continuar desde estados idempotentes de cada elemento, sin un segundo runner global |

La degradación no debe añadir un sistema de checkpoints global que vuelva a
bloquear todo el pipeline. La recuperación debe vivir en el estado idempotente
de alertas, digests e intentos de entrega.

---

## 19. Medición: cuadro de mando correcto

### 19.1 Calidad de decisión

- tasa de territorio incorrecto;
- tasa de afirmaciones sin evidencia;
- tasa de duplicados;
- alertas marcadas útiles por los usuarios;
- rechazos por falta de aplicabilidad;
- oportunidades relevantes omitidas en el corpus histórico;
- acuerdo entre juez LLM, reglas y resultados posteriores;
- tasa de `HOLD_FOR_EVIDENCE` y resolución.

### 19.2 Cobertura y silencio

- usuarios evaluados;
- usuarios con candidatas territoriales;
- usuarios con candidatas aprobadas;
- usuarios sin digest y causa;
- días consecutivos de silencio por usuario y global;
- alertas disponibles que no produjeron ninguna candidata;
- caída anómala frente a su propio histórico.

### 19.3 Experiencia

- mensajes por usuario y semana;
- alertas por digest;
- clics como señal secundaria;
- respuestas útiles;
- solicitudes de menor frecuencia;
- bloqueos o bajas;
- repetición temática;
- tiempo hasta una acción útil.

### 19.4 Entrega

- queued;
- aceptados por proveedor;
- enviados a WhatsApp;
- entregados;
- leídos cuando existe recibo;
- fallidos y no entregados;
- tiempo entre estados;
- reintentos;
- estados desconocidos.

### 19.5 IA y coste

- llamadas por alerta;
- parejas usuario-alerta evaluadas;
- tokens y coste por digest generado;
- latencia;
- errores estructurales;
- abstenciones;
- reintentos;
- distribución de decisiones por versión de modelo/prompt;
- cambios bruscos tras una actualización.

### 19.6 Objetivos de seguridad iniciales

Objetivos aspiracionales que deben medirse, no fingirse:

- otra provincia enviada: 0;
- fecha o cuantía inventada: 0;
- duplicado automático: 0;
- decisión sin reason code: 0;
- digest marcado entregado sin ACK compatible: 0;
- silencio global sin explicación del embudo: 0;

---

## 20. Evaluación antes de producción

La activación puede realizarse de una vez, pero no debe hacerse a ciegas. Antes
se ejecuta el sistema completo de forma offline, sin enviar WhatsApp.

### 20.1 Corpus dorado

Debe contener:

- alertas claramente relevantes;
- claramente irrelevantes;
- casos dudosos;
- otras provincias;
- autonómicas aplicables;
- nacionales;
- expedientes individuales;
- ayudas sin plazo;
- obligaciones;
- cursos;
- documentos incompletos;
- falsos positivos históricos;
- falsos negativos históricos;
- perfiles nuevos, abiertos, especializados y contradictorios.

### 20.2 Replay histórico

Reproducir al menos varias semanas de:

- alertas disponibles cada día;
- perfiles que existían entonces;
- decisiones actuales;
- decisiones propuestas;
- mensajes que se habrían creado;
- feedback y clics posteriores cuando existan.

El replay no escribe envíos ni altera perfiles reales.

### 20.3 Métricas comparativas

- alertas ganadas;
- alertas perdidas;
- cambios territoriales;
- cambios de volumen;
- causas de silencio;
- coste estimado;
- decisiones que cambiaron solo por el LLM;
- contradicciones entre modelo y evidencia;
- estabilidad al repetir la misma entrada.

### 20.4 Evaluación automática sin revisión diaria

- reglas exactas para territorio, fechas, URLs y esquemas;
- corpus versionado para significado;
- un grader LLM independiente como señal auxiliar;
- pruebas metamórficas;
- comparación entre versiones;
- revisión humana solo de anomalías graves o de la creación inicial de un corpus,
  no de cada ejecución diaria.

---

## 21. Pruebas requeridas

### 21.1 Contratos

- ficha válida e inválida;
- salida estructurada del juez;
- reason codes conocidos;
- versiones compatibles;
- campos críticos con evidencia;
- eventos de entrega fuera de orden.

### 21.2 Territorio

- misma provincia;
- otra provincia;
- nacional;
- autonómica que expande correctamente;
- mención incidental de otra provincia;
- municipio de expediente individual;
- perfil sin provincia;
- cambio de provincia del usuario.

### 21.3 Beneficiario y taxonomía

- ganadería frente a agricultura;
- actividad mixta;
- cultivos específicos;
- cooperativa como plan frente a figura jurídica;
- ayudas amplias;
- obligación de entidad concreta;
- contenido transversal;
- exclusión explícita.

### 21.4 Juez LLM

- determinismo razonable;
- abstención por información esencial ausente;
- no obedecer instrucciones dentro del documento;
- no añadir hechos;
- decisión consistente al cambiar el orden de campos;
- caída al eliminar evidencia;
- imposibilidad de rescatar otra provincia;
- tratamiento de perfil nuevo;
- respuesta ante datos contradictorios.

### 21.5 Portfolio

- diversidad;
- máximo de elementos;
- no rellenar;
- urgencia verificada;
- una sola exploración;
- frecuencia;
- horario;
- idempotencia;
- actualizaciones materiales.

### 21.6 Entrega

- aceptado no equivale a entregado;
- ACK pending/server/device/read;
- ACK duplicado;
- ACK desordenado;
- fallo reintentable y definitivo;
- reinicio durante envío;
- conciliación;
- mensaje ya entregado no se repite.

### 21.7 Extremo a extremo

```text
documento → ficha → candidato → decisión → digest → cola → ACK → feedback → perfil
```

Debe existir al menos un caso completo positivo, uno bloqueado, uno retenido y
uno con fallo de transporte.

---

## 22. Seguridad, privacidad y cumplimiento

### 22.1 Minimización

- enviar al LLM solo hechos y perfil necesarios;
- pseudonimizar usuario;
- no incluir teléfono;
- no incluir tokens ni credenciales;
- no enviar conversaciones completas cuando exista memoria estructurada;
- aplicar retención a prompts y respuestas persistidos;
- respetar borrado de memoria y cuenta.

### 22.2 Prompt injection documental

Los boletines y PDFs son datos no confiables. Un texto del documento podría
contener instrucciones. El modelo debe recibirlos delimitados como evidencia y
nunca ejecutar órdenes procedentes del documento.

### 22.3 Auditoría

Guardar:

- versión de ficha;
- versión de política;
- modelo y versión de prompt;
- entrada estructurada o huella reproducible;
- salida estructurada;
- bloqueos;
- decisión final;
- mensaje aprobado;
- intento de entrega;
- ACK;
- feedback aplicado.

Evitar guardar datos personales duplicados dentro de trazas técnicas.

### 22.4 Control del usuario

El usuario debe poder:

- ver o recibir una explicación sencilla;
- cambiar preferencias;
- reducir frecuencia;
- corregir una inferencia;
- borrar memoria aprendida;
- dejar de recibir mensajes;
- no ser penalizado por no contestar.

---

## 23. Coste, rendimiento y selección de modelos

### 23.1 Principio de coste

El LLM no se llama para todas las combinaciones posibles.

```text
muchas alertas
→ reglas baratas
→ embeddings
→ top K pequeño
→ LLM
```

### 23.2 Reutilización

- una ficha por alerta se comparte entre todos los usuarios;
- el perfil semántico se recalcula solo cuando cambia;
- los embeddings se regeneran solo ante cambio de contenido o modelo;
- la explicación del juez alimenta el mensaje;
- las consultas repetidas utilizan resultados versionados cuando la entrada es
  idéntica;
- se agrupan llamadas compatibles en lote.

### 23.3 Modelos por dificultad

- modelo económico para extracción clara y salida estructurada;
- modelo con mayor razonamiento para ambigüedad o alto impacto;
- embeddings para recuperación;
- reglas para hechos exactos;
- plantillas como fallback de redacción.

No se fija un nombre de modelo permanentemente en este documento. Los modelos
cambian; la evaluación contractual debe permitir sustituirlos.

### 23.4 Presupuesto operativo

Registrar y limitar:

- coste diario;
- coste por alerta comprendida;
- coste por usuario evaluado;
- coste por digest aprobado;
- reintentos;
- coste de segunda opinión;
- umbral de degradación a modelo alternativo.

---

## 24. Mapa hacia Ruralicos actual

Este apartado orienta, pero el código y las migraciones deben comprobarse de
nuevo en la conversación que implemente el cambio.

| Necesidad objetivo | Base actual aproximada | Acción recomendada |
| --- | --- | --- |
| Workflow único | `scripts/run_digest_workflow.js` | conservar; modificar solo las fases posteriores a la creación de alertas |
| Clasificación | `alertas.service.js`, clasificación | consolidar alrededor de ficha única |
| Ficha de evidencia | `alertas/intelligence/`, `alert_fact_sheets` | convertir en contrato canónico |
| Territorio y actividad | `seleccion/alertaMatcher.js`, `geography.js` | mantener como barreras duras |
| Ranking | `seleccion/alertSelectionEngine.js` | mantener como pre-ranking explicable |
| Candidatas vectoriales | embeddings y merge de candidatas | limitar a recuperación |
| Perfil aprendido | `aprendizaje/`, `user_interest_profile`, `user_memory` | unificar jerarquía y ámbitos |
| MIA | `modules/mia/`, conversaciones | usar para memoria y feedback, no envío independiente |
| Juez personal | no existe como autoridad única claramente aislada | crear una sola etapa contractual |
| Validador final | `finalDigestValidator.js`, autoridad final | conservar como veto determinista |
| Digest | `digest.routes.js`, `digest.service.js` | reutilizar mensaje y persistencia |
| Decisiones | `digest_candidate_decisions`, `digest_attempts` | reutilizar y versionar antes de crear tablas nuevas |
| Cola | `digestOutbox.js`, `mia_outbox` | unificar semántica de entrega donde proceda |
| WhatsApp | `platform/whatsapp/`, `whatsapp_logs` | añadir correlación y ACK real |
| Feedback | `modules/feedback/` | convertir texto en memorias atómicas |
| Operación | `digest_attempts`, decisiones y logs | ampliar el embudo desde alerta disponible hasta entrega |

### 24.1 Simplificación deseada

El flujo actual contiene fases separadas de clasificación, resumen y revisión.
La arquitectura objetivo debe estudiar su consolidación en:

1. comprensión estructurada de la alerta;
2. verificación condicional solo cuando haga falta;
3. decisión por usuario;
4. redacción derivada de hechos aprobados.

No deben eliminarse funciones solo por su nombre. Primero se identifica qué
garantía aporta cada una, se mueve esa garantía al contrato nuevo y se demuestra
con pruebas que no se ha perdido.

### 24.2 Base de datos

Preferencia: reutilizar antes de crear.

- `alert_fact_sheets` para la ficha;
- `digest_candidate_decisions` para decisiones usuario-alerta;
- `digest_attempts` para el embudo por usuario y día;
- `digests` y `digest_items` para el resultado;
- `whatsapp_logs` o una extensión bien definida para entrega;
- `user_interest_profile` y `user_memory` para aprendizaje.

Solo se diseñará una migración después de verificar columnas, constraints,
índices, RLS, volumen y consumidores reales.

---

## 25. Paquetes de implementación

Estos paquetes representan orden de construcción y verificación. No implican
mantener dos sistemas en producción ni una activación gradual.

### Paquete 0: auditoría de realidad

- leer código, tests, migraciones y variables;
- mapear cada garantía actual;
- identificar duplicidades reales;
- medir volumen de alertas, usuarios, candidatas y llamadas;
- documentar huecos de esquema;
- no escribir en producción.

**Salida:** matriz `existe / parcial / falta / retirar` con evidencia.

### Paquete 1: contratos

- definir versiones de ficha, perfil, decisión y entrega;
- reason codes;
- estados y transiciones;
- política territorial;
- política de evidencia;
- fixtures y validadores.

**Salida:** contratos probados antes de cambiar el comportamiento.

### Paquete 2: comprensión de alerta

- adaptar la ficha actual;
- evidencia por campo;
- relectura automática de evidencia ya almacenada;
- segunda lectura condicional;
- compatibilidad temporal con alertas antiguas;
- pruebas de alertas con evidencia incompleta.

### Paquete 3: perfil de decisión

- jerarquía de señales;
- memoria atómica;
- decay;
- actualización idempotente;
- corrección y borrado;
- representación semántica y legible.

### Paquete 4: candidatas y pre-ranking

- generators exacto, semántico, memoria y cobertura;
- unión con procedencia;
- bloqueos antes del score;
- ranking común;
- top K;
- trazabilidad.

### Paquete 5: juez LLM

- entrada mínima;
- salida estructurada;
- política y prompt versionados;
- abstención;
- segunda opinión selectiva;
- pruebas de inyección, contradicción y frontera;
- coste y latencia.

### Paquete 6: autoridad y portfolio

- decisión final;
- diversidad;
- frecuencia;
- no rellenar;
- urgencia excepcional;
- idempotencia;
- embudo de silencio.

### Paquete 7: mensaje

- bloques derivados de la ficha y del juez;
- plantilla segura;
- tono;
- no inventar;
- longitud;
- enlaces y tracking;
- fallback sin LLM.

### Paquete 8: entrega real

- ID del proveedor;
- activar y verificar ACK de UltraMsg;
- endpoint autenticado;
- máquina de estados;
- reintentos;
- conciliación;
- dashboard de entrega.

### Paquete 9: aprendizaje

- parser de feedback con ámbitos;
- memorias atómicas;
- pesos y límites;
- preguntas poco frecuentes;
- actualización del perfil;
- no aprender de fallos de entrega.

### Paquete 10: evaluación y sustitución

- corpus dorado;
- replay histórico sin envíos;
- comparación completa;
- suite de regresión;
- migración coordinada;
- cambio del workflow actual al contrato nuevo;
- retirada del código que haya quedado realmente sin consumidores;
- documentación final de producción.

---

## 26. Activación conjunta

La preferencia indicada para Ruralicos es no hacer un despliegue gradual por
porcentajes. Eso no elimina la necesidad de verificar antes.

Secuencia:

1. implementar y probar todos los paquetes localmente;
2. aplicar migraciones verificadas en el orden seguro;
3. ejecutar replay offline sin mensajes;
4. corregir regresiones;
5. comprobar credenciales, ACK y observabilidad;
6. desplegar API y cron coordinadamente;
7. activar el flujo completo;
8. vigilar automáticamente las primeras ejecuciones;
9. corregir según resultados reales sin mantener dos cerebros permanentes.

Debe existir rollback operativo del despliegue, aunque no se mantenga un sistema
paralelo como arquitectura permanente.

---

## 27. Criterios de aceptación

El sistema no está terminado solo porque «el cron acabó».

### Comprensión

- toda alerta candidata tiene ficha versionada;
- cada hecho crítico tiene evidencia;
- ausencia de evidencia no se convierte en dato inventado;
- un error técnico no se registra como irrelevancia.

### Personalización

- otra provincia nunca pasa;
- nacional y autonómica aplicable se resuelven correctamente;
- una exclusión explícita se respeta;
- un clic no reescribe el perfil;
- un rechazo concreto conserva su ámbito.

### Decisión

- toda pareja evaluada tiene decisión y motivos;
- el LLM no puede saltarse un bloqueo;
- `HOLD_FOR_EVIDENCE` tiene salida automática;
- una alerta segura puede enviarse aunque no tenga campos opcionales;
- no se rellena el digest con ruido.

### Mensaje

- explica por qué aparece;
- contiene acción cuando existe;
- no afirma plazos no verificados;
- conserva fuente oficial;
- es breve y natural;
- no revela terminología interna.

### Entrega

- cada intento tiene ID e idempotencia;
- aceptado, entregado y leído son estados distintos;
- ACK repetido no duplica efectos;
- fallo de transporte no penaliza intereses;
- reintento no genera un segundo digest.

### Operación

- un solo workflow de producción;
- ningún job queda bloqueando permanentemente otro día;
- cada silencio tiene embudo;
- anomalías de volumen generan aviso;
- coste LLM y entrega son visibles;
- suite completa y replay pasan antes del despliegue.

---

## 28. Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| LLM inventa | ficha con evidencia, esquema estricto y veto final |
| LLM cambia tras actualización | versionado, corpus y comparación |
| Exceso de conservadurismo | bloquear solo datos esenciales; degradar promesas |
| Exceso de mensajes | controlador central, frecuencia y portfolio |
| Silencio inexplicable | embudo y alerta de anomalía |
| Perfil contaminado | jerarquía, ámbitos, límites y decay |
| Embeddings dominan | usarlos solo para candidatas |
| Otra provincia | barrera determinista previa y final |
| Coste elevado | ficha compartida, top K, lotes y modelos por dificultad |
| LLM caído | fallback determinista de alta confianza y plantillas |
| WhatsApp aceptado pero no entregado | ACK y conciliación |
| Código duplicado | un contrato, un controlador y retirada tras pruebas |
| Migración incorrecta | verificar esquema real y probar local/staging |
| Prompt injection | documento tratado como datos delimitados no confiables |
| Métrica equivocada | utilidad, cobertura y bajas; no solo clics |

---

## 29. Decisiones cerradas y preguntas que deben resolverse con datos

### Decisiones cerradas

- arquitectura híbrida;
- territorio como barrera;
- evidencia por campo;
- embeddings como recuperación;
- LLM como juez contextual limitado;
- autoridad final determinista;
- controlador central de comunicaciones;
- feedback natural con ámbito;
- entrega real mediante ACK;
- sin revisión humana diaria;
- un solo cron y un solo flujo;
- activación final conjunta después de replay offline.

### Preguntas para resolver durante la implementación

- top K óptimo según volumen y coste;
- umbrales iniciales por tipo de alerta;
- qué alertas justifican `SEND_NOW`;
- frecuencia por plan y preferencia;
- campos exactos ya presentes en las tablas;
- formato real del webhook ACK de la instancia UltraMsg;
- retención de entradas y salidas del juez;
- modelo más rentable por tarea después de evaluarlo;
- política segura de fallback cuando el juez no está disponible;
- ventana de decay por clase de memoria;
- tamaño mínimo y composición del corpus histórico.

Estas preguntas no deben responderse por intuición si los datos o la
documentación del proveedor pueden resolverlas.

---

## 30. Glosario sencillo

| Término | Significado |
| --- | --- |
| Ficha de hechos | representación comprobada de una alerta |
| Evidencia | fragmento oficial que respalda un dato |
| Barrera dura | regla que ninguna puntuación puede saltarse |
| Candidata | alerta que merece evaluación para un usuario |
| Embedding | representación numérica para encontrar significado parecido |
| Pre-ranking | orden barato antes de usar el LLM |
| Juez LLM | modelo que valora utilidad contextual |
| Autoridad final | reglas que permiten o impiden el envío |
| Portfolio | conjunto completo de alertas que compiten por entrar en el mensaje |
| Decay | pérdida gradual de fuerza de una señal antigua |
| ACK | confirmación del estado de un mensaje |
| Idempotencia | repetir una operación sin duplicar sus efectos |
| Replay | reproducir días históricos sin enviar mensajes reales |
| Corpus dorado | conjunto versionado de ejemplos con resultado esperado |
| Reason code | motivo normalizado de una decisión |

---

## 31. Resultado esperado

Cuando el sistema esté implementado correctamente, Ruralicos deberá poder
explicar cualquier caso con una frase verificable:

> Esta alerta se incluyó porque es una convocatoria ganadera aplicable en
> Huesca, coincide con una necesidad declarada, tiene una acción y evidencia
> suficientes, no estaba repetida y fue una de las tres comunicaciones más
> útiles disponibles. UltraMsg la aceptó y posteriormente confirmó su entrega.

O, si no se envió:

> No se envió porque el documento correspondía a otra provincia.

> No se envió porque faltaba confirmar quién podía beneficiarse y la alerta
> quedó en recuperación automática.

> No se envió porque había candidatas válidas, pero otras dos eran más útiles y
> el usuario había pedido menos frecuencia.

Ese nivel de explicación, unido a evidencia y estados reales de entrega, es lo
que convierte el sistema en una plataforma profesional y no en una colección de
filtros y llamadas a IA.
