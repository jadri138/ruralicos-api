alter table public.ia_runs
  add column if not exists response_id text,
  add column if not exists response_status text,
  add column if not exists incomplete_reason text,
  add column if not exists reasoning_tokens integer;

comment on column public.ia_runs.response_id is
  'Identificador de OpenAI Responses API para correlacionar fallos.';
comment on column public.ia_runs.incomplete_reason is
  'Motivo de una respuesta incompleta, por ejemplo max_output_tokens.';
comment on column public.ia_runs.reasoning_tokens is
  'Tokens de razonamiento consumidos dentro de output_tokens.';

-- Los scrapers comprueban existencia por URL cientos de miles de veces.
-- El indice parcial evita escaneos secuenciales y no almacena nulos.
create index if not exists idx_alertas_url
  on public.alertas (url)
  where url is not null;
