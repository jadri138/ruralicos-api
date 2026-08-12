const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260812211726_rebuild_shadow_v2.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

const oldTables = ['shadow_digest_items', 'shadow_candidate_decisions', 'shadow_digest_runs'];
for (const table of oldTables) {
  assert(new RegExp(`drop table if exists public\\.${table}`, 'i').test(sql));
}

const newTables = [
  'shadow_v2_alert_classifications',
  'shadow_v2_digest_runs',
  'shadow_v2_digest_items',
];
for (const table of newTables) {
  assert(new RegExp(`create table public\\.${table}`, 'i').test(sql));
  assert(new RegExp(`alter table public\\.${table} enable row level security`, 'i').test(sql));
  assert(new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated, service_role`, 'i').test(sql));
  assert(new RegExp(`grant select, insert(?:, update(?:, delete)?)? on table public\\.${table} to service_role`, 'i').test(sql));
}
assert(sql.includes('stop_reason text'));
assert(sql.includes('stop_details jsonb'));

const drops = [...sql.matchAll(/drop table if exists public\.([a-z0-9_]+)/gi)].map((match) => match[1]);
assert.deepStrictEqual(drops, oldTables, 'la migracion solo puede borrar las tres tablas shadow antiguas');
assert.strictEqual((sql.match(/create table public\./gi) || []).length, 3);
assert(sql.includes("model = 'gpt-5-nano'"));
assert(sql.includes("model = 'gpt-5.6-luna'"));
assert(!/drop table[^;]*(users|alertas|raw_documents|digests|digest_items|mia_outbox)/i.test(
  sql.replace(/shadow_digest_items/g, 'shadow_old_items')
));

console.log('OK: migracion shadow-v2 limitada a tres tablas, RLS y acceso service_role');
