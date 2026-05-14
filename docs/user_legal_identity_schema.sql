begin;

alter table public.users
  add column if not exists first_name text,
  add column if not exists last_name_1 text,
  add column if not exists last_name_2 text,
  add column if not exists legal_name text;

update public.users
set legal_name = nullif(trim(coalesce(name, '')), '')
where legal_name is null
  and nullif(trim(coalesce(name, '')), '') is not null;

create index if not exists idx_users_legal_name
  on public.users (legal_name);

comment on column public.users.first_name is 'Nombre del usuario para cruces con listados oficiales.';
comment on column public.users.last_name_1 is 'Primer apellido del usuario para cruces con listados oficiales.';
comment on column public.users.last_name_2 is 'Segundo apellido del usuario para cruces con listados oficiales.';
comment on column public.users.legal_name is 'Nombre legal completo usado para detectar coincidencias en listados oficiales donde aparezcan personas o beneficiarios.';

commit;
