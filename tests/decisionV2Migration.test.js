const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260810172543_add_decision_v2_shadow_tables.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

console.log('\n=== TESTS: migracion decision-v2 shadow ===\n');

for (const table of [
  'shadow_digest_runs',
  'shadow_candidate_decisions',
  'shadow_digest_items',
]) {
  assert(new RegExp(`create table public\\.${table}\\s*\\(`, 'i').test(sql), `falta ${table}`);
  assert(new RegExp(`alter table public\\.${table} enable row level security`, 'i').test(sql), `falta RLS en ${table}`);
  assert(
    new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i').test(sql),
    `faltan revocaciones publicas en ${table}`
  );
  assert(
    new RegExp(`on table public\\.${table}[\\s\\S]{0,100}to service_role`, 'i').test(sql),
    `falta acceso service_role en ${table}`
  );
}

assert(/shadow_run_id uuid primary key/i.test(sql));
assert(/unique \(workflow_run_key, user_id\)/i.test(sql));
assert(/status in \('GENERATED', 'EMPTY', 'ERROR'\)/i.test(sql));
assert(/llm_raw_responses jsonb/i.test(sql));
assert(/mensaje_preview text/i.test(sql));
assert(/rendered_block text not null/i.test(sql));
assert(/references public\.users \(id\)/i.test(sql));
assert(/references public\.alertas \(id\)/i.test(sql));
assert(!/\bis_shadow\b/i.test(sql), 'no debe contaminar tablas reales con is_shadow');

for (const table of [
  'digests',
  'digest_items',
  'alerta_click_links',
  'alerta_clicks',
  'mia_outbox',
  'whatsapp_logs',
]) {
  assert(!new RegExp(`(insert into|update|delete from)\\s+public\\.${table}\\b`, 'i').test(sql));
}

console.log('OK: tres tablas aisladas, RLS deny-all publico y claves de evaluacion');
console.log('OK: la migracion no escribe ni modifica ninguna tabla de entrega');
console.log('\nResultados decisionV2Migration: 2 aprobados, 0 fallidos');
