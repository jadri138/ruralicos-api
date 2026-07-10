-- Dedupe a nivel de BD para el digest via outbox (DIGEST_VIA_OUTBOX).
-- Un digest concreto solo puede estar UNA vez en la cola para un telefono:
-- si /alertas/enviar-digest se ejecuta dos veces (cron solapado, reintento del
-- pipeline), el segundo encolado choca con el unique y se cuenta como
-- ya_encolado (codigo 23505 tratado en digestOutbox.js).
create unique index if not exists uq_mia_outbox_digest
  on public.mia_outbox (channel, to_phone, ((metadata_json->>'digest_id')))
  where metadata_json ? 'digest_id';
