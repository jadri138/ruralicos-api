create table if not exists public.verification_codes (
  id bigserial primary key,
  user_id bigint not null,
  phone text not null,
  purpose text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint verification_codes_purpose_check
    check (purpose in ('phone_verification', 'password_reset')),
  constraint verification_codes_attempts_check
    check (attempts >= 0)
);

create index if not exists idx_verification_codes_user_purpose_active
  on public.verification_codes (user_id, purpose, created_at desc)
  where consumed_at is null;

create index if not exists idx_verification_codes_expires_at
  on public.verification_codes (expires_at);

create index if not exists idx_verification_codes_phone_purpose
  on public.verification_codes (phone, purpose, created_at desc);

alter table public.verification_codes enable row level security;

grant select, insert, update, delete on table public.verification_codes to service_role;
grant usage, select on sequence public.verification_codes_id_seq to service_role;

comment on table public.verification_codes is
  'Codigos temporales de verificacion de telefono y recuperacion de contrasena. Guarda hashes, no codigos en claro.';

comment on column public.verification_codes.purpose is
  'phone_verification o password_reset.';

comment on column public.verification_codes.code_hash is
  'Hash SHA-256 con pepper del codigo, proposito y telefono.';

comment on column public.verification_codes.attempts is
  'Intentos de comprobacion contra este codigo.';

comment on column public.verification_codes.consumed_at is
  'Fecha en la que el codigo se uso o se invalidó por rotacion/intentos.';
