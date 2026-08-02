# Supabase

Definición versionada de la base de datos Postgres utilizada por la API. La fuente de verdad del esquema en Git son las migraciones de [`migrations/`](migrations/).

## Principios

- El backend usa `SUPABASE_SERVICE_ROLE_KEY`; nunca se entrega a los frontends.
- Las tablas y columnas nuevas se crean mediante una migración nueva.
- Una migración ya aplicada no se edita.
- Índices, constraints, RLS, funciones y políticas deben versionarse junto al cambio.
- El código no debe esconder indefinidamente una migración ausente.

## Grupos de datos

| Dominio | Tablas principales |
| --- | --- |
| Usuarios | `users`, `user_memory`, `user_interest_profile`, `user_conversations` |
| Alertas | `alertas`, `raw_documents`, `alert_fact_sheets`, `official_list_matches` |
| Digest/feedback | `digests`, `digest_items`, `digest_attempts`, `digest_candidate_decisions`, `alerta_clicks`, `alerta_feedback` |
| MIA | `mia_inbound_messages`, `mia_decisions`, `mia_actions`, `mia_outbox`, `mia_structured_memory`, `mia_agent_cases`, conocimiento y revisiones |
| Partner | `organizations`, miembros, personal, clientes, zonas y eventos |
| Operación | `pipeline_runs`, `scraper_runs`, `ia_runs`, auditoría y logs |
| Presupuesto IA | `alert_decision_llm_daily_budget` |

La lista exacta evoluciona con las migraciones.

## Contratos de decisión y entrega

[`20260801211224_alert_decision_delivery_contracts.sql`](migrations/20260801211224_alert_decision_delivery_contracts.sql)
es una migración aditiva y forward-only para:

- versionar decisiones usuario-alerta y el embudo del digest;
- añadir idempotencia, estados de entrega, marcas de tiempo e ID del proveedor;
- crear `whatsapp_delivery_events` con RLS y acceso solo del backend;
- convertir `user_memory` en memoria atómica canónica;
- programar recuperación acotada de fichas usando material ya almacenado;
- reservar de forma atómica las llamadas diarias del juez, con RLS y acceso
  exclusivo de `service_role`;
- conservar decisiones, intentos y ACK 180 días para replay y auditoría, y
  minimizar el outbox terminal a 30 días.

La migración está versionada en el repositorio, pero este trabajo no la ha
aplicado al proyecto remoto. La API nueva y la migración deben desplegarse en la
misma ventana. Ver el procedimiento completo en
[`docs/SISTEMA_DECISION_ALERTAS_LLM_IMPLEMENTADO.md`](../docs/SISTEMA_DECISION_ALERTAS_LLM_IMPLEMENTADO.md#migración-de-supabase).

## Flujo local recomendado

Con Supabase CLI configurado:

```powershell
supabase migration list
supabase db reset
```

Para remoto, revisar primero proyecto y diff:

```powershell
supabase link --project-ref <project-ref>
supabase migration list --linked
# Comparar el historial remoto con todos los archivos de migrations/.
# Solo después de resolver cualquier diferencia:
supabase db push
```

Si las columnas local y remota de `migration list --linked` no coinciden, hay
que detenerse. No ejecutar `db push`, `migration repair` ni marcar versiones
como aplicadas hasta entender y reconciliar el historial con una copia de
seguridad y una ventana coordinada. `db push` es una modificación externa:
confirmar siempre que el proyecto vinculado es el correcto.

Para volver atrás durante una incidencia, detener el cron y restaurar primero
la versión anterior de la API. Dejar las columnas aditivas evita perder trazas.
Una retirada posterior del esquema requiere otra migración revisada; no hacer
un `DROP` manual como rollback urgente.

## Crear una migración

```powershell
supabase migration new descripcion_breve
```

Después:

1. escribir SQL compatible con el estado anterior;
2. decidir backfill, valor por defecto y nulabilidad;
3. añadir índices a claves foráneas y consultas reales;
4. revisar RLS/roles;
5. probar en base local limpia y actualizada;
6. añadir prueba de contrato/migración si afecta lógica crítica;
7. documentar impacto y rollback operativo.

## Seguridad

Las migraciones de julio de 2026 endurecen acceso de roles API al esquema público. No conceder permisos amplios para resolver un error puntual. Las rutas partner necesitan aislamiento tanto en la consulta del backend como en las políticas que correspondan.

## Retención

La retención operativa está versionada en migraciones y coordinada por `src/services/retencionDatos.js`. `RETENTION_ENABLED=false` mantiene el borrado real apagado por defecto. Ver `docs/CUMPLIMIENTO.md`.
