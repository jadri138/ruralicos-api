-- Ejecutar manualmente solo despues de que:
--   npm run repair:legacy-discards -- --apply
-- termine con failed=[] y anuncie que la validacion esta lista.
-- Este fichero no forma parte de las migraciones y nunca se ejecuta solo.

begin;

do $validation$
declare
  incomplete_discards bigint;
begin
  select count(*)
  into incomplete_discards
  from public.alertas
  where estado_ia = 'descartado'
    and not coalesce(
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
    );

  if incomplete_discards > 0 then
    raise exception
      'No se puede validar alertas_structured_discard_check: quedan % descartes incompletos',
      incomplete_discards;
  end if;
end
$validation$;

alter table public.alertas
  validate constraint alertas_structured_discard_check;

commit;
