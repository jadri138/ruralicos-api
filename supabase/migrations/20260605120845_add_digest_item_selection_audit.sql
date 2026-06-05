alter table public.digest_items
  add column if not exists selection_score double precision,
  add column if not exists selection_action text,
  add column if not exists selection_reason text,
  add column if not exists selection_risk text,
  add column if not exists similarity_score double precision,
  add column if not exists selection_decision jsonb not null default '{}'::jsonb;

create index if not exists idx_digest_items_selection_score
  on public.digest_items (selection_score desc);

create index if not exists idx_digest_items_selection_action_fecha
  on public.digest_items (selection_action, fecha desc);

comment on column public.digest_items.score is
  'Legacy score column. New writes store the final alert selection score when available, otherwise vector similarity.';

comment on column public.digest_items.selection_score is
  'Final score returned by the alert selection engine for this digest item.';

comment on column public.digest_items.selection_action is
  'Selection engine action, for example include or review.';

comment on column public.digest_items.selection_reason is
  'Primary reason returned by the alert selection engine.';

comment on column public.digest_items.selection_risk is
  'Risk bucket returned by the alert selection engine.';

comment on column public.digest_items.similarity_score is
  'Vector similarity used by MIA/pgvector ranking when available.';

comment on column public.digest_items.selection_decision is
  'Full selection decision payload used to audit why the alert entered the digest.';
