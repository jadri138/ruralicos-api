# Migraciones

Se aplican en orden por el timestamp del nombre y Supabase registra la versión en `supabase_migrations.schema_migrations`.

Formato:

```text
AAAAMMDDHHMMSS_descripcion.sql
```

## Baseline

`20260101000000_baseline_schema.sql` es una fotografía idempotente del esquema consolidado a comienzos de julio de 2026. Define 39 tablas base, constraints, índices, funciones, secuencias y políticas conocidas entonces.

- En una base fresca crea el punto de partida.
- En una base existente usa `if not exists` donde corresponde.
- No contiene las evoluciones posteriores a su fecha; las migraciones siguientes siguen siendo obligatorias.
- No se debe actualizar el baseline cada vez que aparece una migración.

## Evolución posterior

Las migraciones incrementales añaden, entre otros:

- auditoría de selección e intentos de digest;
- verificación telefónica;
- aislamiento y analítica partner;
- documentos brutos, preclasificación y fichas;
- base del motor de inteligencia;
- ejecuciones de IA, auditoría admin y jobs;
- restricciones/índices y deduplicación de outbox;
- versión de credenciales;
- retención operativa y diagnósticos;
- descarte auditable/estructurado;
- snapshots de audiencia;
- snapshots de salud de recomendaciones de MIA.

Consultar los nombres de los archivos en orden para el detalle exacto.

## Convenciones

- No editar una migración aplicada.
- Preferir operaciones idempotentes cuando sea razonable.
- Añadir constraint `not null` solo después de rellenar datos existentes.
- Crear índices para claves foráneas y filtros frecuentes.
- Evitar bloqueos largos: separar backfills grandes.
- Cualificar objetos con `public.`.
- Revisar permisos/RLS al crear tabla o función.
- Añadir comentarios SQL cuando una restricción no sea obvia.

## `raw_documents` e historial

En un entorno antiguo, `raw_documents` pudo crearse manualmente sin quedar la versión `20260617120000` en el historial. Primero comparar esquema. Si coincide, reparar solo el historial:

```powershell
supabase migration repair --status applied 20260617120000
```

Si faltan objetos y la migración es segura en ese entorno, aplicar con `supabase db push`. No marcar como aplicada una migración cuyo esquema no existe.

## Verificación

```powershell
supabase migration list
supabase db reset
npm run test:local
```

Para cambios específicos, ejecutar además la prueba de migración/contrato correspondiente, por ejemplo audiencia, inteligencia, descartes o retención.
