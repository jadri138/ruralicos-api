-- Ruralicos - pgvector para recomendaciones inteligentes
-- Ejecutar en Supabase SQL Editor antes de activar /embeddings/* en produccion.

begin;

create extension if not exists vector;

alter table public.alertas
  add column if not exists embedding vector(1536),
  add column if not exists embedding_generated_at timestamptz;

alter table public.users
  add column if not exists perfil_embedding vector(1536),
  add column if not exists perfil_actualizado_at timestamptz;

create index if not exists idx_alertas_embedding_ivfflat
  on public.alertas
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists idx_alertas_embedding_null
  on public.alertas(id)
  where embedding is null and estado_ia = 'listo';

create or replace function public.buscar_alertas_similares(
  perfil_vector vector(1536),
  fecha_busqueda text,
  limite integer default 7
)
returns table (
  id bigint,
  titulo text,
  resumen_final text,
  url text,
  fuente text,
  provincias jsonb,
  sectores jsonb,
  subsectores jsonb,
  tipos_alerta jsonb,
  similitud double precision
)
language sql
stable
as $$
  select
    a.id,
    a.titulo,
    a.resumen_final,
    a.url,
    a.fuente,
    a.provincias,
    a.sectores,
    a.subsectores,
    a.tipos_alerta,
    1 - (a.embedding <=> perfil_vector) as similitud
  from public.alertas a
  where a.fecha = fecha_busqueda
    and a.estado_ia = 'listo'
    and a.embedding is not null
  order by a.embedding <=> perfil_vector
  limit greatest(1, least(coalesce(limite, 7), 50));
$$;

commit;
