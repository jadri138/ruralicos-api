# Document trace

## Problema actual

La tabla `alertas` no tiene `raw_document_id`. La relacion disponible hoy vive al
reves:

```text
raw_documents.inserted_alerta_id -> alertas.id
```

Por eso cualquier trazabilidad documental debe buscar desde `raw_documents` por
`inserted_alerta_id`, no desde un campo inexistente en `alertas`.

## Que hace `documentTrace.js`

`src/modules/alertas/intelligence/documentTrace.js` resuelve de forma segura el
documento bruto asociado a una alerta:

- busca `raw_documents` por `inserted_alerta_id = alertas.id`;
- respeta `organization_id` cuando ese dato esta disponible en el documento;
- no depende de `alertas.raw_document_id`;
- no bloquea digest ni flujos posteriores si no encuentra documento;
- devuelve un resumen estable: `found`, `raw_document_id`, `source_url`,
  `official_id`, `content_hash`, `text_excerpt`, `evidence_available` y
  `reason`.

## Casos cubiertos

- Documento encontrado y enlazado por `inserted_alerta_id`.
- `not_found` cuando no existe `raw_documents` asociado.
- `organization_id` distinto, evitando cruzar documentos de otra organizacion.
- Multiples candidatos, eligiendo el mas completo y avisando.
- Cliente Supabase ausente, con fallback seguro.
- Tabla o columna no disponible, sin lanzar excepcion hacia el flujo llamador.

## Importante

Esto no integra con digest todavia.

Esto no endurece `alertQuality`.

Esto no cambia WhatsApp.

Es solo trazabilidad documental segura para fases posteriores de evidence-first.
