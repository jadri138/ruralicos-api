alter table public.alertas
  add column if not exists audience_reach jsonb not null default '{}'::jsonb,
  add column if not exists audience_reach_updated_at timestamp with time zone;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'alertas_audience_reach_object_check'
      and conrelid = 'public.alertas'::regclass
  ) then
    alter table public.alertas
      add constraint alertas_audience_reach_object_check
      check (jsonb_typeof(audience_reach) = 'object');
  end if;
end
$$;

comment on column public.alertas.audience_reach is
  'Ultimo snapshot agregado de alcance; no contiene identificadores de usuarios.';

comment on column public.alertas.audience_reach_updated_at is
  'Momento en que se registro el ultimo snapshot agregado de alcance.';
