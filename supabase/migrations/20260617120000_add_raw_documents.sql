-- Captura bruta/auditable de documentos detectados por los scrapers, ANTES de
-- filtrar o insertar en alertas. Garantiza que ningun documento oficial
-- desaparezca en silencio (sin URL, duplicado o descartado por una regla).

create table if not exists public.raw_documents (
  id bigserial primary key,
  fuente text not null,
  region text,
  fecha date,
  titulo text,
  url text,
  url_html text,
  url_pdf text,
  organismo text,
  seccion text,
  boletin text,
  id_oficial text,
  texto_raw text,
  contenido_hash text,
  url_hash text,
  scraper_run_id bigint,
  capture_status text not null default 'detected',
  capture_reason text,
  metadata_json jsonb not null default '{}'::jsonb,
  inserted_alerta_id bigint references public.alertas (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint raw_documents_capture_status_check
    check (capture_status in (
      'detected', 'inserted', 'duplicate', 'missing_url', 'skipped_by_rule', 'error'
    )),
  constraint raw_documents_metadata_object_check
    check (jsonb_typeof(metadata_json) = 'object')
);

-- UNIQUE normal (no parcial): Postgres trata los NULL como distintos, asi que los
-- documentos sin URL (url_hash NULL) siguen pudiendo insertarse varias veces, y a
-- la vez sirve como destino valido de onConflict('fuente,url_hash') en el upsert.
create unique index if not exists idx_raw_documents_fuente_url_hash
  on public.raw_documents (fuente, url_hash);

create index if not exists idx_raw_documents_fuente_fecha
  on public.raw_documents (fuente, fecha desc);

create index if not exists idx_raw_documents_capture_status
  on public.raw_documents (capture_status);

create index if not exists idx_raw_documents_contenido_hash
  on public.raw_documents (contenido_hash)
  where contenido_hash is not null;

create index if not exists idx_raw_documents_url_hash
  on public.raw_documents (url_hash)
  where url_hash is not null;

alter table public.raw_documents enable row level security;

grant select, insert, update, delete on table public.raw_documents to service_role;
grant usage, select on sequence public.raw_documents_id_seq to service_role;

comment on table public.raw_documents is
  'Captura bruta auditable de documentos detectados por scrapers de boletines, previa al filtrado e insercion en alertas. Ningun documento oficial detectado debe desaparecer sin quedar aqui registrado.';

comment on column public.raw_documents.capture_status is
  'Estado de captura: detected (registrado), inserted (paso a alertas), duplicate (ya existia), missing_url (sin URL), skipped_by_rule (descartado por filtro), error (fallo al insertar).';

comment on column public.raw_documents.capture_reason is
  'Motivo legible del estado no insertado, p.ej. rural_filter_no_match, departamento_no_relevante, duplicate_url, missing_url.';

comment on column public.raw_documents.inserted_alerta_id is
  'alertas.id creada a partir de este documento cuando capture_status = inserted.';

comment on column public.raw_documents.scraper_run_id is
  'Referencia suelta a scraper_runs.id; nullable (el run se registra a posteriori en el modulo tareas).';
