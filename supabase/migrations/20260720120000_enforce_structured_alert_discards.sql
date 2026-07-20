-- Impide nuevos descartes sin trazabilidad estructurada. NOT VALID evita que
-- las filas historicas incompletas bloqueen la migracion; se corrigen con el
-- script repair_legacy_alert_discards.js antes de validar la restriccion.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'alertas_structured_discard_check'
      and conrelid = 'public.alertas'::regclass
  ) then
    alter table public.alertas
      add constraint alertas_structured_discard_check
      check (
        estado_ia is distinct from 'descartado'
        or coalesce(
          btrim(discard_reason_code) <> ''
          and btrim(discard_reason) <> ''
          and btrim(discard_stage) <> ''
          and discard_confidence between 0::double precision and 1::double precision
          and jsonb_typeof(decision_audit) = 'object'
          and jsonb_typeof(decision_audit -> 'discard') = 'object'
          and decision_audit #>> '{discard,code}' = discard_reason_code
          and decision_audit #>> '{discard,reason}' = discard_reason
          and decision_audit #>> '{discard,stage}' = discard_stage
          and case
            when jsonb_typeof(decision_audit #> '{discard,confidence}') = 'number'
              then (decision_audit #>> '{discard,confidence}')::double precision = discard_confidence
            else false
          end,
          false
        )
      ) not valid;
  end if;
end
$$;

comment on constraint alertas_structured_discard_check on public.alertas is
  'Todo estado_ia=descartado nuevo debe conservar motivo, etapa, confianza y decision_audit coherentes.';
