# Migraciones Supabase

Las migraciones se aplican en orden por su prefijo de timestamp y quedan registradas
en la tabla `supabase_migrations.schema_migrations` (columna `version` = el timestamp
del fichero, p. ej. `20260617120000`).

## Convenciones

- **Nombre:** `AAAAMMDDHHMMSS_descripcion.sql`. El timestamp debe ser **posterior** al
  de la ultima migracion ya aplicada para que se ejecute en orden.
- **Idempotencia:** preferir `create table/index if not exists` y
  `alter table ... add column if not exists`, de modo que reaplicar una migracion no
  rompa un entorno donde el objeto ya existe.

## Baseline del schema (`20260101000000_baseline_schema.sql`)

Volcado completo del schema de produccion (2026-07-05): 39 tablas, constraints,
indices, funciones, triggers, secuencias, RLS y comentarios. Va con timestamp
**anterior** a todas las demas migraciones a proposito:

- **Entorno fresco:** el baseline crea el schema completo primero y las
  migraciones posteriores (idempotentes) hacen no-op donde ya exista el objeto.
- **Produccion:** no hace falta aplicarlo (el schema ya existe); es 100%
  idempotente, asi que aplicarlo tampoco rompe nada.
- **Contrato:** a partir del baseline, el codigo asume que TODAS las tablas
  existen. El patron defensivo `MISSING_TABLE_CODES`/`esTablaNoDisponible`/
  `isMissingTableError` se elimino de `src/` y no debe reintroducirse; un error
  de PostgREST por tabla/columna inexistente es un bug de despliegue, no un
  estado tolerable.

## Reconciliar `raw_documents` (la tabla existe en prod pero no figura en el historial)

Sintoma observado: `public.raw_documents` existe en produccion, pero
`supabase_migrations.schema_migrations` **no** contiene la fila `20260617120000`
(`20260617120000_add_raw_documents.sql`). Esto ocurre cuando la tabla se creo fuera
del flujo de migraciones (p. ej. ejecutando el SQL a mano en el panel).

No hay tabla duplicada: solo existe **una** definicion de `raw_documents` en el repo
(`20260617120000_add_raw_documents.sql`) y es idempotente.

Para dejar el historial coherente **sin recrear ni romper la tabla**, usar una de:

1. **Marcar como aplicada (recomendado, no toca el esquema):**
   ```bash
   supabase migration repair --status applied 20260617120000
   ```

2. **Reaplicar la migracion (segura por ser `if not exists`):**
   ```bash
   supabase db push
   ```
   Al ser toda la migracion `create ... if not exists`, no duplica objetos; si faltara
   algun indice/columna, lo crea, y queda registrada en el historial.

Tras cualquiera de las dos, `supabase migration list` debe mostrar `20260617120000`
como aplicada tanto en local como en remoto.
