-- Motivos estructurados de descarte. Se mantienen nullable para no inventar
-- datos historicos y para que una alerta relevante no arrastre un descarte.
alter table if exists public.alertas
  add column if not exists discard_reason_code text,
  add column if not exists discard_stage text,
  add column if not exists discard_confidence double precision;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'alertas_discard_confidence_range'
      and conrelid = 'public.alertas'::regclass
  ) then
    alter table public.alertas
      add constraint alertas_discard_confidence_range
      check (
        discard_confidence is null
        or discard_confidence between 0::double precision and 1::double precision
      );
  end if;
end
$$;

comment on column public.alertas.discard_reason_code is
  'Codigo estable y procesable del motivo de descarte.';
comment on column public.alertas.discard_stage is
  'Etapa del pipeline que tomo la decision de descarte.';
comment on column public.alertas.discard_confidence is
  'Confianza normalizada entre 0 y 1 de la decision de descarte.';
