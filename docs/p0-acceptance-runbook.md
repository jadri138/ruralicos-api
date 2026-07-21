# Runbook del gate de aceptación P0

## Alcance

El comando único es:

```powershell
npm.cmd run p0:acceptance -- <opciones>
```

Ejecuta, en este orden lógico:

1. lint;
2. toda la suite local descubierta por `scripts/run_tests.js`;
3. `check:core`;
4. las pruebas focalizadas de P0.1 a P0.8;
5. validación de la matriz garantía → prueba;
6. comprobación de ficheros de migración y esquema objetivo;
7. inventario agregado de solo lectura;
8. generación opcional de informes JSON y texto.

El informe registra el SHA al inicio y confirma al final que no cambió y que el
árbol permaneció limpio. Por ello el gate debe ejecutarse sobre un commit, no
sobre cambios sin confirmar.

## Garantías de solo lectura

El modo PostgreSQL:

- solo admite `--target=staging`; `production` no es un valor válido;
- exige una credencial que pueda hacer `SELECT` pero no `INSERT`, `UPDATE`,
  `DELETE` ni `TRUNCATE` en `public.alertas` o `public.raw_documents`;
- abre `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
- comprueba `SHOW transaction_read_only` antes del diagnóstico;
- acepta únicamente sentencias individuales que empiecen por `SELECT`, `WITH` o
  `SHOW`, con una lista de verbos y funciones mutantes bloqueada;
- termina siempre con `ROLLBACK` y nunca con `COMMIT`;
- no llama RPC, no aplica migraciones y no ejecuta SQL de reparación o
  validación de constraints.

Las pruebas de estas garantías están en
`tests/p0AcceptanceInventory.test.js`.

## Preparación común

Requisitos:

- Node.js compatible con `package.json`;
- dependencias instaladas con `npm.cmd ci`;
- checkout situado en `ruralicos-api`;
- árbol Git limpio y commit candidato ya creado.

No deben estar ejecutándose scrapers, crons, digests ni tareas de reparación como
parte de este runbook.

## Ejecución local con fixtures

PowerShell:

```powershell
Set-Location C:\dev\ruralicos\ruralicos-api
$p0ReportDir = Join-Path $env:TEMP 'ruralicos-p0-acceptance'
New-Item -ItemType Directory -Force -Path $p0ReportDir | Out-Null
$p0Json = Join-Path $p0ReportDir 'p0-acceptance-local.json'
$p0Text = Join-Path $p0ReportDir 'p0-acceptance-local.txt'

npm.cmd run p0:acceptance -- `
  "--source=fixture" `
  "--target=local" `
  "--json=$p0Json" `
  "--text=$p0Text"

$LASTEXITCODE
```

El modo local usa exclusivamente
`tests/fixtures/p0/acceptance-corpus.json`. No abre conexiones externas.

## Ejecución contra staging en modo lectura

Antes de empezar, una persona responsable debe confirmar que la URL corresponde
a staging y que el rol ya existente es de solo lectura. Este runbook no crea ni
modifica roles.

El rol necesita:

- `USAGE` y lectura de metadatos en los esquemas necesarios;
- `SELECT` sobre `public.alertas`, `public.raw_documents` y
  `supabase_migrations.schema_migrations`;
- acceso de lectura a `information_schema` y `pg_catalog`;
- ningún privilegio de escritura sobre las dos tablas inventariadas.

PowerShell:

```powershell
Set-Location C:\dev\ruralicos\ruralicos-api
$env:P0_ACCEPTANCE_DATABASE_URL = 'postgresql://P0_READER:REDACTED@STAGING_HOST:5432/postgres?sslmode=require'
$p0ReportDir = Join-Path $env:TEMP 'ruralicos-p0-acceptance'
New-Item -ItemType Directory -Force -Path $p0ReportDir | Out-Null
$p0Json = Join-Path $p0ReportDir 'p0-acceptance-staging.json'
$p0Text = Join-Path $p0ReportDir 'p0-acceptance-staging.txt'

npm.cmd run p0:acceptance -- `
  "--source=postgres" `
  "--target=staging" `
  "--database-url-env=P0_ACCEPTANCE_DATABASE_URL" `
  "--json=$p0Json" `
  "--text=$p0Text"

$p0ExitCode = $LASTEXITCODE
Remove-Item Env:P0_ACCEPTANCE_DATABASE_URL
$p0ExitCode
```

No reutilizar este ejemplo con una URL de producción. El marcador
`--target=staging` es una protección de intención, no un detector de proyectos:
la URL y el rol deben verificarse fuera del comando.

## Contenido del inventario

El informe solo conserva conteos agregados:

- alertas agrupadas por fuente y `estado_ia`;
- totales de `pendiente_revision_manual` y `needs_evidence`;
- descartes totales, estructurados e incompletos;
- `NO IMPORTA` fuera de `descartado`;
- alertas `listo` con campos o auditoría de descarte;
- cobertura de `raw_documents` para BOPA, DOGC y DOE: alertas, enlaces, raws,
  texto y metadatos oficiales disponibles;
- tablas, columnas y versiones de migración requeridas;
- existencia y `convalidated` de `alertas_structured_discard_check`;
- rol utilizado, estado de la transacción y presencia de privilegios de
  escritura.

No incluye identificadores de alerta, títulos, contenidos, URLs oficiales,
teléfonos, datos personales, claves ni URL de conexión.

## Códigos de salida

| Código | Estado | Significado |
| --- | --- | --- |
| `0` | `acceptable` | Código, matriz, esquema e invariantes P0 aceptables |
| `1` | `check_failed` | Falló lint/pruebas/diagnóstico, la credencial puede escribir o hay una anomalía dura |
| `2` | `schema_not_applied` | La comprobación funcionó, pero faltan tablas, columnas, migraciones o la constraint requerida |
| `3` | error de uso | Argumentos inválidos, modo producción o configuración incompleta |

Una constraint presente pero no validada y los descartes históricos incompletos
no hacen fallar el gate: se enumeran como `pending_work`, porque requieren un
backfill controlado. En cambio, bloquean el cierre operativo de P0:

- un gate con código distinto de cero;
- migraciones, columnas o constraint ausentes;
- una conexión que no sea realmente read-only;
- `NO IMPORTA` fuera de `descartado`;
- alertas `listo` que conserven campos de descarte;
- un inventario que no pueda completarse.

## Checklist de aceptación

- [ ] El SHA del informe coincide con el candidato y `candidate.clean` es `true`.
- [ ] Lint, suite completa, `check:core` y pruebas focalizadas están en `pass`.
- [ ] Todas las garantías P0.1–P0.8 tienen al menos una prueba existente.
- [ ] No falta ningún fichero local de migración requerido.
- [ ] `diagnostic.schema.status` es `pass`.
- [ ] La transacción figura read-only y el rol no tiene privilegios de escritura.
- [ ] Los dos contadores de anomalías duras son cero.
- [ ] Se revisaron los conteos de estados retenidos y cobertura raw por fuente.
- [ ] Se archivaron los informes JSON y texto sin secretos.
- [ ] `discard_backfill_readiness.status` es `ready` antes del backfill de descartes.

## Qué no hace este gate

El gate no repara descartes, no valida constraints, no aporta evidencia, no
reprocesa alertas retenidas y no aplica migraciones.
