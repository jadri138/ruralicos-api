-- MIA curated agrarian knowledge base
-- Run this in Supabase SQL editor after pgvector is available.

create extension if not exists vector;
create extension if not exists pg_trgm;

create table if not exists public.mia_knowledge_documents (
  id bigserial primary key,
  organization_id bigint null,
  titulo text not null,
  categoria text not null,
  fuente text null,
  fuente_tipo text not null default 'manual',
  url text null,
  fecha_documento date null,
  version text null,
  status text not null default 'active'
    check (status in ('draft', 'active', 'archived')),
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mia_knowledge_chunks (
  id bigserial primary key,
  document_id bigint not null references public.mia_knowledge_documents(id) on delete cascade,
  organization_id bigint null,
  chunk_index integer not null,
  titulo text null,
  contenido text not null,
  embedding vector(1536) null,
  content_hash text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, chunk_index),
  unique (document_id, content_hash)
);

create index if not exists idx_mia_knowledge_documents_status
  on public.mia_knowledge_documents(status);

create index if not exists idx_mia_knowledge_documents_categoria
  on public.mia_knowledge_documents(categoria);

create index if not exists idx_mia_knowledge_documents_org
  on public.mia_knowledge_documents(organization_id);

create index if not exists idx_mia_knowledge_chunks_document
  on public.mia_knowledge_chunks(document_id);

create index if not exists idx_mia_knowledge_chunks_org
  on public.mia_knowledge_chunks(organization_id);

create index if not exists idx_mia_knowledge_chunks_embedding
  on public.mia_knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists idx_mia_knowledge_chunks_contenido_trgm
  on public.mia_knowledge_chunks
  using gin (contenido gin_trgm_ops);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_mia_knowledge_documents_updated_at on public.mia_knowledge_documents;
create trigger trg_mia_knowledge_documents_updated_at
before update on public.mia_knowledge_documents
for each row execute function public.touch_updated_at();

drop trigger if exists trg_mia_knowledge_chunks_updated_at on public.mia_knowledge_chunks;
create trigger trg_mia_knowledge_chunks_updated_at
before update on public.mia_knowledge_chunks
for each row execute function public.touch_updated_at();

create or replace function public.buscar_mia_knowledge_chunks_por_embedding(
  p_query_embedding vector(1536),
  p_match_count integer default 8,
  p_min_similarity double precision default 0.18,
  p_organization_id bigint default null
)
returns table (
  id bigint,
  document_id bigint,
  titulo text,
  resumen text,
  snippet text,
  fuente text,
  fuente_tipo text,
  categoria text,
  url text,
  fecha date,
  organization_id bigint,
  similitud double precision,
  chunk_index integer,
  metadata_json jsonb
)
language sql
stable
as $$
  select
    c.id,
    d.id as document_id,
    coalesce(c.titulo, d.titulo) as titulo,
    left(c.contenido, 1200) as resumen,
    left(c.contenido, 520) as snippet,
    d.fuente,
    d.fuente_tipo,
    d.categoria,
    d.url,
    d.fecha_documento as fecha,
    coalesce(c.organization_id, d.organization_id) as organization_id,
    1 - (c.embedding <=> p_query_embedding) as similitud,
    c.chunk_index,
    c.metadata_json
  from public.mia_knowledge_chunks c
  join public.mia_knowledge_documents d on d.id = c.document_id
  where
    d.status = 'active'
    and c.embedding is not null
    and (
      p_organization_id is null
      and coalesce(c.organization_id, d.organization_id) is null
      or p_organization_id is not null
      and (
        coalesce(c.organization_id, d.organization_id) is null
        or coalesce(c.organization_id, d.organization_id) = p_organization_id
      )
    )
    and 1 - (c.embedding <=> p_query_embedding) >= p_min_similarity
  order by c.embedding <=> p_query_embedding
  limit greatest(1, least(50, coalesce(p_match_count, 8)));
$$;
