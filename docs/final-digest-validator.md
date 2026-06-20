# Final digest validator

## Objetivo

El validador final revisa el mensaje de WhatsApp ya redactado antes de que pueda
considerarse apto para envio automatico. Es una pieza aislada: no llama a IA, no
escribe en base de datos y no envia mensajes.

## Modulo

- `src/modules/digest/finalDigestValidator.js`

## Contrato

La salida normalizada es:

```js
{
  ok: true | false,
  status: 'send' | 'review_only' | 'blocked',
  flags: [],
  reasons: [],
  item_results: []
}
```

`ok` solo es `true` cuando `status` es `send`.

## Reglas actuales

Por item, el validador exige:

- fact sheet presente para envio automatico;
- `factSheet.status !== "blocked"`;
- URL oficial verificada en la fact sheet;
- bloque de mensaje con enlace;
- decision de seleccion `include`;
- plazos mencionados solo si `factSheet.plazo` esta verificado;
- importes mencionados solo si `factSheet.importe` esta verificado;
- territorios mencionados solo si `factSheet.territorio` los verifica;
- frases como "te afecta" solo con match fuerte de seleccion;
- obligaciones solo con `accion_requerida` verificada;
- ayudas/subvenciones solo con convocatoria, beneficiarios o base suficiente;
- frases genericas quedan en `review_only`.

## Match fuerte

Para afirmar afectacion directa, la seleccion debe tener:

- `action: "include"`;
- riesgo bajo;
- score minimo 75;
- provincia expresa o nacional;
- sector, subsector o tipo expreso.

Tambien se acepta `match_strength: "fuerte"` o `strong_match: true`.

## Integracion futura

La Fase 7 debe llamarlo en modo sombra desde `digest.service.js` y guardar en
`digest_items.tags_json`:

- `final_validation_status`
- `final_validation_flags`
- `final_validation_reasons`
- `shadow_decision`

La Fase 8 podra convertir `blocked` y `review_only` en enforcement real.
