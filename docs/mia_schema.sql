-- Ruralicos - Motor de Inteligencia Adaptativa (MIA)
-- Fase 1: infraestructura definitiva de datos.
-- Ejecutar en Supabase SQL Editor. Es idempotente.

begin;

-- 1. Vector search
create extension if not exists vector;

-- 2. Columnas en alertas
alter table public.alertas
  add column if not exists embedding vector(1536),
  add column if not exists embedding_generated_at timestamptz;

-- 3. Columnas en users
alter table public.users
  add column if not exists perfil_embedding vector(1536),
  add column if not exists perfil_version integer not null default 0,
  add column if not exists contexto_narrativo text,
  add column if not exists ultima_interaccion_at timestamptz,
  add column if not exists perfil_actualizado_at timestamptz;

-- 4. Feedback por alerta. Se crea si no existe y debe permitir neutro.
create table if not exists public.alerta_feedback (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  digest_id bigint references public.digests(id) on delete cascade,
  alerta_id bigint not null references public.alertas(id) on delete cascade,
  item_numero integer,
  valor smallint not null default 0,
  canal text not null default 'whatsapp',
  raw_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.alerta_feedback enable row level security;

do $$
begin
  alter table public.alerta_feedback
    drop constraint if exists alerta_feedback_valor_check;

  alter table public.alerta_feedback
    add constraint alerta_feedback_valor_check check (valor in (-1, 0, 1));
end $$;

create unique index if not exists ux_alerta_feedback_user_digest_alerta
  on public.alerta_feedback(user_id, digest_id, alerta_id);

create index if not exists idx_alerta_feedback_user_created
  on public.alerta_feedback(user_id, created_at desc);

create index if not exists idx_alerta_feedback_alerta
  on public.alerta_feedback(alerta_id);

-- 5. Memoria persistente del usuario
create table if not exists public.user_memory (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  tipo text not null check (tipo in (
    'feedback_positivo',
    'feedback_negativo',
    'indiferencia',
    'mensaje_libre',
    'dato_explotacion',
    'interes_detectado',
    'desinteres_detectado',
    'pregunta_usuario',
    'pregunta_sistema',
    'respuesta_exploracion',
    'evento_estacional'
  )),
  contenido text not null,
  alerta_id bigint references public.alertas(id) on delete set null,
  digest_id bigint references public.digests(id) on delete set null,
  peso_inicial double precision not null default 1.0,
  incorporado_a_embedding boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.user_memory enable row level security;

-- 6. Registro de exploracion activa
create table if not exists public.exploration_log (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  digest_id bigint references public.digests(id) on delete set null,
  alerta_id bigint not null references public.alertas(id) on delete cascade,
  tipo_exploracion text not null check (tipo_exploracion in (
    'zona_expansion',
    'terreno_nuevo',
    'pregunta_activa'
  )),
  motivo text,
  resultado text check (resultado is null or resultado in (
    'positivo',
    'negativo',
    'sin_respuesta'
  )),
  procesado boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.exploration_log enable row level security;

-- 7. Conversaciones activas multi-turno por WhatsApp
create table if not exists public.user_conversations (
  id bigserial primary key,
  user_id bigint not null references public.users(id) on delete cascade,
  estado text not null default 'activa' check (estado in (
    'activa',
    'resuelta',
    'expirada'
  )),
  tipo text not null check (tipo in (
    'feedback_digest',
    'pregunta_exploracion',
    'respuesta_consulta'
  )),
  contexto_json jsonb,
  digest_id bigint references public.digests(id) on delete set null,
  abierta_at timestamptz not null default now(),
  cerrada_at timestamptz,
  expira_at timestamptz not null default (now() + interval '24 hours')
);

alter table public.user_conversations enable row level security;

-- 8. Indices
create index if not exists idx_alertas_embedding
  on public.alertas
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists idx_alertas_embedding_pendiente
  on public.alertas(id)
  where embedding is null and estado_ia = 'listo';

create index if not exists idx_user_memory_user_id
  on public.user_memory(user_id);

create index if not exists idx_user_memory_tipo
  on public.user_memory(tipo);

create index if not exists idx_user_memory_created_at
  on public.user_memory(created_at);

create index if not exists idx_user_memory_user_pending_embedding
  on public.user_memory(user_id, created_at desc)
  where incorporado_a_embedding = false;

create index if not exists idx_exploration_log_user_created
  on public.exploration_log(user_id, created_at desc);

create index if not exists idx_exploration_log_resultado
  on public.exploration_log(resultado);

create index if not exists idx_user_conversations_user_estado
  on public.user_conversations(user_id, estado);

create index if not exists idx_user_conversations_expira
  on public.user_conversations(expira_at)
  where estado = 'activa';

-- 9. Busqueda semantica reutilizable
create or replace function public.buscar_alertas_similares(
  p_perfil_vector vector(1536),
  p_fecha text,
  p_limite integer default 10
)
returns table (
  id bigint,
  titulo text,
  resumen_final text,
  url text,
  sectores jsonb,
  subsectores jsonb,
  tipos_alerta jsonb,
  provincias jsonb,
  fuente text,
  similitud double precision
)
language sql
stable
as $$
  select
    a.id,
    a.titulo,
    a.resumen_final,
    a.url,
    a.sectores,
    a.subsectores,
    a.tipos_alerta,
    a.provincias,
    a.fuente,
    1 - (a.embedding <=> p_perfil_vector) as similitud
  from public.alertas a
  where a.fecha = p_fecha
    and a.estado_ia = 'listo'
    and a.embedding is not null
    and a.duplicado_de is null
  order by a.embedding <=> p_perfil_vector
  limit greatest(1, least(coalesce(p_limite, 10), 50));
$$;

commit;
