const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260625123000_add_intelligence_schema_foundation.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

assert(
  /add column if not exists taxonomy_tags jsonb not null default '\[\]'::jsonb/i.test(sql),
  'Añade taxonomy_tags de forma aditiva'
);
assert(
  /create table if not exists public\.digest_candidate_decisions/i.test(sql),
  'Crea la auditoría completa de candidatos'
);
assert(
  /unique index if not exists idx_digest_candidate_decisions_unique_stage/i.test(sql),
  'La escritura por etapa es idempotente'
);
assert(
  /enable row level security/i.test(sql),
  'Activa RLS en la tabla expuesta'
);
assert(
  /revoke all on table public\.digest_candidate_decisions from public, anon, authenticated/i.test(sql),
  'Revoca acceso de clientes públicos'
);
assert(
  /grant select, insert, update, delete[\s\S]+to service_role/i.test(sql),
  'Concede acceso operativo únicamente al backend'
);

console.log('OK: migración de base intelligence aditiva, auditable y restringida');
