# Fact sheet evidence-first

## Objetivo

La ficha maestra convierte una alerta en hechos verificables antes de que la
alerta pueda alimentar seleccion, digest o mensajes de WhatsApp. Es una capa
aislada: no envia, no escribe en tablas y no cambia el comportamiento actual del
digest.

## Modulos

- `src/modules/alertas/intelligence/factSheetSchema.js`
- `src/modules/alertas/intelligence/factSheetBuilder.js`
- `src/modules/alertas/intelligence/factSheetValidator.js`
- `src/modules/alertas/intelligence/factSheetStore.js`

## Regla principal

Si un campo no tiene evidencia textual clara, queda vacio:

- campos escalares: `{ valor: null, evidencia: null, status: "no_verificado" }`
- listas: `[]`

No se completan territorio, plazo, beneficiarios, importe, accion requerida,
sector ni tipo documental por intuicion.

## Fuente de evidencia

El builder puede trabajar de tres formas:

1. con `rawDocument` directo;
2. con `documentTrace` ya resuelto;
3. con `supabase`, en cuyo caso llama a `resolverDocumentTrace`.

La relacion correcta entre documento bruto y alerta es:

```text
raw_documents.inserted_alerta_id -> alertas.id
```

No se usa `alertas.raw_document_id` porque no existe como contrato fiable.

## Campos principales

- `tipo_documento`
- `tema_principal`
- `resumen_neutro`
- `territorio`
- `sectores`
- `subsectores`
- `accion_requerida`
- `plazo`
- `beneficiarios`
- `importe`
- `requisitos`
- `url_oficial`
- `evidencias`
- `truth_score`
- `risk_score`
- `evidence_coverage`
- `status`
- `flags`
- `reasons`

Cada evidencia guarda campo, valor, fragmento textual, fuente y confianza.

## Estados

- `ready_for_digest`: ficha suficiente para envio automatico.
- `review_only`: potencialmente util, pero necesita revision o preview.
- `blocked`: no debe entrar en digest automatico.
- `insufficient_evidence`: falta materia prima para tomar decision.

## Validaciones actuales

El validador detecta:

- URL oficial ausente;
- evidencia minima insuficiente;
- tipo, tema, sector o territorio no verificados;
- plazo ausente o inventado;
- ayuda sin beneficiario ni convocatoria;
- expediente individual;
- sancion o notificacion individual;
- resumen generico;
- contradicciones simples entre texto, tipo y sector.

## Uso

```js
const { construirFactSheetAlerta } = require('./src/modules/alertas/intelligence/factSheetBuilder');

const factSheet = await construirFactSheetAlerta(alerta, { supabase });
```

Para tests o procesos sin base de datos:

```js
const { construirFactSheetAlertaSync } = require('./src/modules/alertas/intelligence/factSheetBuilder');

const factSheet = construirFactSheetAlertaSync(alerta, { rawDocument });
```

Para persistir en modo sombra:

```js
const { guardarFactSheetShadow } = require('./src/modules/alertas/intelligence/factSheetStore');

await guardarFactSheetShadow(supabase, {
  factSheet,
  organizationId,
  shadowDecision: { current: 'include', future: factSheet.status },
});
```

## Integracion futura

Fases posteriores deben usar esta ficha primero en modo sombra. Solo despues de
medir falsos positivos y falsos negativos debe usarse para bloquear envios.
