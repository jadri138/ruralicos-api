const assert = require('assert');
const fs = require('fs');
const path = require('path');

const migrationPath = path.join(
  __dirname,
  '..',
  'supabase',
  'migrations',
  '20260721212629_add_alert_audience_reach_snapshot.sql'
);
const sql = fs.readFileSync(migrationPath, 'utf8');

assert(
  /alter table public\.alertas[\s\S]+add column if not exists audience_reach jsonb not null default '\{\}'::jsonb/i.test(sql),
  'El snapshot de alcance se anade de forma aditiva e idempotente'
);
assert(
  /add column if not exists audience_reach_updated_at timestamp with time zone/i.test(sql),
  'La fecha de actualizacion tambien es aditiva'
);
assert(
  /alertas_audience_reach_object_check[\s\S]+jsonb_typeof\(audience_reach\) = 'object'/i.test(sql),
  'La base exige que el snapshot sea un objeto JSON'
);
assert(
  /no contiene identificadores de usuarios/i.test(sql),
  'La migracion documenta que el snapshot solo conserva agregados'
);
assert(
  !/create table/i.test(sql),
  'La mejora reutiliza alertas y no expone una tabla nueva'
);

console.log('OK: migracion de alcance aditiva, agregada e idempotente');
