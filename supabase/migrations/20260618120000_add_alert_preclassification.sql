-- Capa de preclasificacion barata (sin IA) sobre `alertas`. Permite ordenar las
-- alertas ANTES de gastar tokens de IA y dejar auditada cada decision del
-- pipeline (preclasificacion barata -> IA -> quality gate -> digest).
--
-- Todas las columnas son opcionales y nullable: la migracion es aditiva y no
-- altera el comportamiento actual hasta que se active ALERT_PRECLASSIFIER_ENABLED
-- y se cablee /alertas/clasificar en un PR posterior.

alter table public.alertas
  -- Resultado del preclasificador barato (alertPreclassifier.js):
  add column if not exists pre_score numeric,            -- suma de senales (positivas - negativas)
  add column if not exists pre_status text,              -- keep | review | discard | needs_evidence
  add column if not exists pre_reasons jsonb,            -- [{ tag, weight }] auditable
  add column if not exists candidate_level text,         -- strong_candidate | weak_candidate | discard_rule | needs_ai | needs_evidence

  -- Estado de la alerta de cara al digest (se rellenara en la fase de digest):
  add column if not exists digest_status text,           -- p.ej. pendiente | incluida | excluida
  add column if not exists discard_reason text,          -- motivo legible cuando se descarta

  -- Traza completa de decisiones del pipeline para auditoria end-to-end:
  add column if not exists decision_audit jsonb;

-- Indice para consultar/contar por nivel de candidatura sin escanear toda la tabla
-- (util para metricas "cuantas alertas evitaron IA" y para el panel admin).
create index if not exists idx_alertas_candidate_level
  on public.alertas (candidate_level);

create index if not exists idx_alertas_digest_status
  on public.alertas (digest_status);

comment on column public.alertas.pre_score is 'Preclasificacion barata sin IA: score de senales agrarias (positivas menos negativas).';
comment on column public.alertas.pre_status is 'Preclasificacion barata: keep | review | discard | needs_evidence.';
comment on column public.alertas.pre_reasons is 'Preclasificacion barata: array JSON [{tag, weight}] con las reglas que dispararon.';
comment on column public.alertas.candidate_level is 'Preclasificacion barata: strong_candidate | weak_candidate | discard_rule | needs_ai | needs_evidence.';
comment on column public.alertas.digest_status is 'Estado de la alerta respecto al digest diario.';
comment on column public.alertas.discard_reason is 'Motivo legible por el que se descarto la alerta.';
comment on column public.alertas.decision_audit is 'Traza JSON de decisiones del pipeline (preclasificacion, IA, quality gate, digest).';
