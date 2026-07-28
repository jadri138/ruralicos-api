# Boletines oficiales

Ingesta de fuentes. Detecta publicaciones, descarga contenido, conserva evidencia bruta, aplica un prefiltro rural explicable y crea alertas sin decidir todavía el destinatario.

## Flujo

```text
portal oficial
  → scraper: documentos normalizados
  → raw_documents: captura y estado
  → prefiltro pass / review / discard
  → procesador compartido
  → alertas pendientes de inteligencia
  → scraper_runs + métricas de salud
```

## Estructura

| Carpeta/archivo | Función |
| --- | --- |
| [`scrapers/`](scrapers/) | Descarga y parseo específico por fuente |
| [`rutas/`](rutas/) | Endpoints de cron y adaptación a persistencia |
| [`rawDocuments/`](rawDocuments/) | Registro del documento original y trazabilidad |
| `fuentesHealth.js` | Salud agregada de fuentes |
| `scraperRunQuality.js` | Clasifica una ejecución como correcta, advertencia o error |
| `scraperSkip.js` | Razones estructuradas para documentos saltados |

## Fuentes implementadas

- Estatal: BOE.
- Autonómicas: BOA, BOCAN, BOCANT, BOCCE, BOCM, BOCYL, BOIB, BOJA, BOME, BON, BOPA, BOPV, BOR, BORM, DOCM, DOE, DOG, DOGC y DOGV.
- Provinciales de Aragón: BOPZ, BOPH y BOPT.
- Provinciales del País Vasco: BOTHA y BOG.
- Complementaria estatal: listados FEGA.

BOB y los dos boletines provinciales canarios están preparados en estructura, pero no tienen scraper/ruta funcional. No deben configurarse como fuente activa.

## Contrato de un documento

Un scraper devuelve, cuando sea posible:

- identificador oficial;
- título;
- fecha y número de boletín;
- fuente, región y organismo;
- URL oficial HTML/PDF;
- texto extraído;
- contexto de sumario;
- decisión de prefiltro y diagnóstico.

Si falla el detalle después de detectar el anuncio, se prefiere conservar la captura y marcarla para revisión antes que perderla silenciosamente.

## Prefiltro

El prefiltro devuelve `pass`, `review` o `discard`, señales positivas/negativas y un código de razón. Es una optimización de ingesta, no la decisión final de envío.

- `pass`: evidencia rural suficiente.
- `review`: contexto insuficiente o ambiguo; se conserva.
- `discard`: evidencia clara de que no entra al dominio.

Los documentos descartados pueden quedar registrados como `skipped_by_rule` para poder auditar falsos negativos.

## Salud

“Cero documentos” puede ser normal en festivo, pero también puede indicar que cambió el portal. `scraperRunQuality` usa estado HTTP, contadores, mensaje y diagnósticos para diferenciarlos. Los paneles consumen `scraper_runs` y `/tareas/salud-fuentes`.

## Añadir una fuente

1. Crear scraper y fixtures de HTML/PDF sin datos sensibles.
2. Devolver el contrato común y distinguir “sin publicación” de fallo de parseo.
3. Registrar la ruta con token de cron.
4. Insertar por los procesadores compartidos y raw documents.
5. Añadirla a `src/routes.js`.
6. Configurarla en la lista diaria apropiada.
7. Añadir pruebas de parseo, duplicado, filtro, error y fecha vacía.
8. Documentarla en los índices de `scrapers` y `rutas`.
