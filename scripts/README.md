# Scripts

Herramientas de desarrollo, diagnóstico, backfill, reparación y aceptación. Se ejecutan desde la raíz de `ruralicos-api`.

## Seguros y locales

| Script/comando | Uso |
| --- | --- |
| `npm run test:local` | Descubre y ejecuta todos los `tests/*.test.js` en procesos aislados |
| `npm run check:core` | Comprueba invariantes críticas por análisis/ejecución local |
| `npm run rutas:inventario` | Lista endpoints montados sin abrir servidor |
| `npm run openapi:generar` | Regenera `docs/openapi.json` |
| `compare_fichas.js` | Compara resultados de fichas |
| `measure_factsheet_evidence.js` | Mide cobertura de evidencia |
| `npm run replay:alert-decisions` | Reproduce el corpus local por días; no usa red, Supabase ni WhatsApp |

`run_tests.js` admite filtro:

```powershell
node scripts\run_tests.js mia
node scripts\run_tests.js digest
```

## Operativos con base de datos

| Comando/script | Efecto |
| --- | --- |
| `npm run workflow:digest` | Ejecuta el flujo de digest contra una API configurada |
| `npm run backfill:intelligence` | Completa inteligencia/fichas históricas |
| `npm run repair:legacy-discards` | Repara descartes antiguos sin estructura suficiente |
| `npm run repair:stale-pipeline-jobs` | Diagnostica/repara jobs huérfanos |
| `npm run knowledge:ingest` | Ingiere documentos autorizados en la base de conocimiento |
| `npm run replay:export-snapshots -- --from <fecha> --to <fecha> --output <archivo>` | Solo lee Supabase y crea un corpus local sanitizado; nunca sobrescribe |
| `npm run replay:grade -- --enable --input <informe>` | Grader OpenAI auxiliar, apagado por defecto; no cambia la aceptación |
| `auditoria_seleccion_digest.js` | Analiza decisiones de selección |
| `recover_bopa_evidence.js` | Recupera evidencia BOPA |
| `seed_partner_demo.js` | Crea datos de demostración partner |

Salvo `replay:export-snapshots`, que está limitado a `select`, estos scripts
pueden leer o escribir Supabase. `replay:grade` llama a OpenAI pero desactiva la
auditoría de base de datos. Antes de ejecutarlos:

1. verificar `SUPABASE_URL`;
2. leer `--help` o la cabecera del script;
3. usar `dry-run`/límites si existen;
4. comenzar con un ID o lote pequeño;
5. guardar contadores antes/después;
6. no interrumpir una escritura sin revisar cómo reanuda.

## Aceptación P0

`npm run p0:acceptance` coordina:

- `p0-acceptance/config.js`: configuración;
- `guarantees.json`: garantías declaradas;
- `readOnlyInventory.js`: inventario de solo lectura;
- `report.js`: informe.

Consulta `docs/p0-acceptance-runbook.md` antes de usarlo contra un entorno real.

## SQL auxiliar

`sql/validate_alert_discard_constraint.sql` valida el contrato de descartes. Es una consulta/herramienta de comprobación; las modificaciones permanentes de esquema pertenecen a `supabase/migrations`.

## Reglas

- No incrustar credenciales ni teléfonos.
- Un script de reparación debe ser reanudable e idempotente.
- Diferenciar claramente lectura, `dry-run` y escritura.
- Imprimir resumen y códigos de salida útiles.
- Evitar envíos reales por defecto.
- Si una herramienta pasa a ser parte periódica del producto, mover su lógica a un módulo y dejar el script como adaptador.
