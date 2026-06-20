alter table public.alerta_feedback
  add column if not exists feedback_category text,
  add column if not exists feedback_confidence double precision,
  add column if not exists feedback_detail jsonb not null default '{}'::jsonb;

create index if not exists idx_alerta_feedback_category_created
  on public.alerta_feedback (feedback_category, created_at desc)
  where feedback_category is not null;

comment on column public.alerta_feedback.feedback_category is
  'Clasificacion determinista del feedback sobre digest: wrong_topic, wrong_location, too_generic, misclassification, individual_case_noise, user_profile_missing, useful o unclear.';

comment on column public.alerta_feedback.feedback_confidence is
  'Confianza de la clasificacion del feedback, entre 0 y 1.';

comment on column public.alerta_feedback.feedback_detail is
  'Detalle auditable de la clasificacion: razones, flags y extractos usados.';
