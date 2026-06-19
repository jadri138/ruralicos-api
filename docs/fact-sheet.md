# Fact sheet evidence-first

La ficha maestra evidence-first es una capa nueva y aislada para describir una
alerta sin inventar datos. No esta integrada con digest, seleccion ni calidad.

## Contrato de entrada

```js
{
  alerta,
  rawDocument: optional,
  textoFuente: optional
}
```

`alertas` no tiene `raw_document_id` en el sistema actual. La relacion existe al
reves: `raw_documents.inserted_alerta_id -> alertas.id`. Por eso el builder no
lee ni necesita `alerta.raw_document_id`.

## Regla principal

Cada dato factual debe tener una evidencia textual. Si no aparece en
`rawDocument` o `textoFuente`, queda como `no_verificado` o lista vacia.

Cuando no hay `rawDocument` ni `textoFuente`, el builder devuelve una ficha de
revision:

- `status = review_only`
- `evidence_coverage = bajo`
- `evidence_score = 0`
- `evidences = []`

## Modulos

- `factSheetSchema.js`: contrato, estados, cobertura y helpers puros.
- `factSheetBuilder.js`: crea la ficha desde entrada flexible sin tocar BD.
- `factSheetValidator.js`: comprueba que no hay hechos sin evidencia textual.

## Uso previsto

La siguiente fase puede cargar `raw_documents` mediante
`raw_documents.inserted_alerta_id = alertas.id` y pasar esa fila al builder.
Hasta entonces tambien se puede usar `textoFuente` en tests o diagnosticos.

No se debe integrar aun en `digest.service.js`, `digestItems.js`,
`alertSelectionEngine.js` ni `alertQuality.js`.

## Tests

- `tests/factSheetValidator.test.js`: contrato e integridad de evidencia (relacion
  inversa `raw_documents.inserted_alerta_id -> alertas.id`, `review_only` sin fuente,
  rechazo de valores sin evidencia, campos vacios como `no_verificado`/`[]`).
- `tests/factSheet.test.js`: los 8 escenarios de negocio sobre el contrato
  `construirFactSheet({ alerta, rawDocument, textoFuente })`:
  1. curso de bienestar animal (el tipo sale del documento, no de la etiqueta erronea de la alerta);
  2. ayuda/subvencion con plazo claro (plazo con evidencia);
  3. ayuda sin plazo (plazo `no_verificado`, no inventado);
  4. concesion de aguas individual (rasgo de expediente + territorio);
  5. sancion individual (tipo `sancion` + rasgo de expediente);
  6. alerta generica sin fuente (`review_only`, sin evidencias inventadas);
  7. alerta sin URL (`source.urls.oficial = null`, evidencia textual igualmente registrada);
  8. provincia no demostrada (`territorio = no_verificado`, no se hereda de `alerta.region`).

Ambos se ejecutan dentro de `npm run test:local`.
