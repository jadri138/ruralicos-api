#!/usr/bin/env node
//
// Seed de la cooperativa DEMO para el panel partner (B2B white-label).
//
// Crea una cooperativa de muestra (`coop-olivos`) con su login de staff, socios,
// zonas y digests, suficiente para enseñar el panel de extremo a extremo a una
// cooperativa o inversor. NO toca el pipeline B2C ni los socios reales: todos los
// datos demo quedan colgando de la organizacion demo y son borrables con --clean.
//
// Uso:
//   node scripts/seed_partner_demo.js                 # crea/actualiza la demo (idempotente)
//   node scripts/seed_partner_demo.js --clean         # borra la demo coop-olivos y sus datos
//   node scripts/seed_partner_demo.js --clean-slug X  # borra la cooperativa de slug X (modo seguro, ver abajo)
//
// Idempotente: re-ejecutar no duplica nada (upsert por slug/email/phone/zona).
//
// Seguridad del borrado:
//   --clean        borra coop-olivos COMPLETA, incluidos sus socios demo (telefonos 346000000xx).
//   --clean-slug X borra la organizacion X, su staff, zonas, members y digests. Los `users`
//                  vinculados solo se BORRAN si son demo (telefono con DEMO_PHONE_PREFIX);
//                  el resto se DESVINCULAN (organization_id = null) para no destruir socios reales.

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { supabase } = require('../src/platform/supabase');

// ──────────────────────────────────────────────────────────────────
// Definicion de la cooperativa demo
// ──────────────────────────────────────────────────────────────────
const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);
const DEMO_SLUG = 'coop-olivos';
const DEMO_PHONE_PREFIX = '346000000'; // 9 chars; + 2 digitos = 11 (formato ES valido y claramente falso)
const DEMO_PASSWORD = 'Olivos2026!';
const DEMO_STAFF_EMAIL = 'demo@coop-olivos.es';

const ORG = {
  slug: DEMO_SLUG,
  name: 'Cooperativa Olivos del Sur',
  kind: 'cooperativa',
  status: 'active',
  branding_json: {
    brand_name: 'Olivos del Sur',
    reply_sender: 'Olivos del Sur',
    assistant_name: 'Oliva',
    digest_title: 'Tus ayudas del olivar',
    website: 'https://olivosdelsur.example',
    logo_url: 'https://ui-avatars.com/api/?name=Olivos+del+Sur&background=3f8f4f&color=fff&bold=true',
    primary_color: '#3f8f4f',
    support_label: 'Soporte Olivos del Sur',
    white_label: true,
  },
  settings_json: {
    billing_band: 'basica',
    billing_status: 'pagando',
    contact_name: 'Ana Belmonte',
    contact_phone: '34600111222',
    contact_email: 'gerencia@olivosdelsur.example',
    notes: 'Cooperativa de demostracion para el panel partner.',
  },
};

const STAFF = {
  email: DEMO_STAFF_EMAIL,
  name: 'Ana Belmonte',
  member_role: 'owner',
  status: 'active',
};

const ZONAS = [
  { name: 'Vega Baja', color: '#2563eb', notes: 'Regadio del bajo Segura.' },
  { name: 'Sierra Norte', color: '#f59e0b', notes: 'Olivar de montaña.' },
  { name: 'Litoral', color: '#10b981', notes: 'Explotaciones costeras.' },
];

// Clientes propios de la cooperativa (tabla organization_clients, registro libre).
// zone = indice en ZONAS (o null). Contacto: phone o email (la tabla exige uno).
const CLIENTES = [
  { display_name: 'Finca El Olivar', first_name: 'Tomás', last_name: 'Aranda', phone: '34699000001', email: 'tomas@elolivar.example', zone: 0, status: 'active', client_type: 'socio',
    profile: { province: 'Alicante', municipality: 'Orihuela', activity_type: 'olivar', crops: ['olivar', 'almendro'], livestock: [], farm_size: '42 ha' },
    preferences: { digest_enabled: true, whatsapp_enabled: true, email_enabled: false, frequency: 'daily', topics: ['PAC', 'riego', 'seguros agrarios'], provinces: ['Alicante'], lonja_products: ['aceite de oliva'] } },
  { display_name: 'Hermanos Cerdá', first_name: 'Vicente', last_name: 'Cerdá', phone: '34699000002', email: null, zone: 0, status: 'active', client_type: 'socio',
    profile: { province: 'Alicante', municipality: 'Callosa de Segura', activity_type: 'hortícola', crops: ['alcachofa', 'brócoli'], livestock: [], farm_size: '18 ha' },
    preferences: { digest_enabled: true, whatsapp_enabled: true, email_enabled: false, frequency: 'daily', topics: ['PAC', 'agua', 'modernización'], provinces: ['Alicante', 'Murcia'], lonja_products: [] } },
  { display_name: 'Aceites Sierra Mágina', first_name: 'Lucía', last_name: 'Pérez', phone: '34699000003', email: 'info@sierramagina.example', zone: 1, status: 'active', client_type: 'cliente',
    profile: { province: 'Jaén', municipality: 'Cambil', activity_type: 'olivar', crops: ['olivar'], livestock: [], farm_size: '120 ha' },
    preferences: { digest_enabled: true, whatsapp_enabled: false, email_enabled: true, frequency: 'weekly', topics: ['PAC', 'aceite', 'exportación'], provinces: ['Jaén'], lonja_products: ['aceite de oliva virgen extra'] } },
  { display_name: 'Ganadería Los Pinos', first_name: 'Andrés', last_name: 'Molina', phone: '34699000004', email: null, zone: 1, status: 'active', client_type: 'socio',
    profile: { province: 'Jaén', municipality: 'Huelma', activity_type: 'ganadería', crops: [], livestock: ['ovino', 'caprino'], farm_size: '300 cabezas' },
    preferences: { digest_enabled: true, whatsapp_enabled: true, email_enabled: false, frequency: 'daily', topics: ['PAC', 'ganadería', 'bienestar animal'], provinces: ['Jaén'], lonja_products: ['cordero'] } },
  { display_name: 'Cítricos del Sur', first_name: 'Marta', last_name: 'Gil', phone: '34699000005', email: 'marta@citricosdelsur.example', zone: 2, status: 'active', client_type: 'cliente',
    profile: { province: 'Valencia', municipality: 'Cullera', activity_type: 'cítricos', crops: ['naranja', 'mandarina'], livestock: [], farm_size: '65 ha' },
    preferences: { digest_enabled: true, whatsapp_enabled: true, email_enabled: true, frequency: 'daily', topics: ['PAC', 'sanidad vegetal', 'comercialización'], provinces: ['Valencia'], lonja_products: ['naranja'] } },
  { display_name: 'Bodega Marina Alta', first_name: 'Pau', last_name: 'Server', phone: '34699000006', email: 'pau@marinalta.example', zone: 2, status: 'prospect', client_type: 'prospecto',
    profile: { province: 'Alicante', municipality: 'Teulada', activity_type: 'viñedo', crops: ['uva moscatel'], livestock: [], farm_size: '22 ha' },
    preferences: { digest_enabled: false, whatsapp_enabled: false, email_enabled: true, frequency: 'weekly', topics: ['PAC', 'viñedo'], provinces: ['Alicante'], lonja_products: ['uva'] } },
  { display_name: 'Cooperativa Vega Media', first_name: 'Rosa', last_name: 'Hernández', phone: '34699000007', email: 'rosa@vegamedia.example', zone: null, status: 'active', client_type: 'socio',
    profile: { province: 'Murcia', municipality: 'Molina de Segura', activity_type: 'mixta', crops: ['limón', 'melocotón'], livestock: [], farm_size: '54 ha' },
    preferences: { digest_enabled: true, whatsapp_enabled: true, email_enabled: false, frequency: 'daily', topics: ['PAC', 'agua', 'frutales'], provinces: ['Murcia'], lonja_products: ['limón', 'melocotón'] } },
  { display_name: 'Almazara San Isidro', first_name: 'Joaquín', last_name: 'Ruiz', phone: '34699000008', email: null, zone: null, status: 'inactive', client_type: 'socio',
    profile: { province: 'Córdoba', municipality: 'Baena', activity_type: 'olivar', crops: ['olivar'], livestock: [], farm_size: '88 ha' },
    preferences: { digest_enabled: false, whatsapp_enabled: false, email_enabled: false, frequency: 'daily', topics: ['aceite'], provinces: ['Córdoba'], lonja_products: ['aceite de oliva'] } },
];

// 15 socios demo. zone = indice en ZONAS (o null). status active salvo uno inactive.
const SOCIOS = [
  { nombre: 'José Martínez Ruiz', subscription: 'cooperativa', role: 'member', zone: 0, status: 'active' },
  { nombre: 'María Gómez Pérez', subscription: 'cooperativa', role: 'agent', zone: 0, status: 'active' },
  { nombre: 'Antonio López Sáez', subscription: 'corral', role: 'member', zone: 0, status: 'active' },
  { nombre: 'Carmen Navarro Gil', subscription: 'cooperativa', role: 'member', zone: 1, status: 'active' },
  { nombre: 'Francisco Torres Mora', subscription: 'free', role: 'viewer', zone: 1, status: 'active' },
  { nombre: 'Isabel Romero Díaz', subscription: 'cooperativa', role: 'member', zone: 1, status: 'active' },
  { nombre: 'Manuel Ortega Ríos', subscription: 'corral', role: 'member', zone: 2, status: 'active' },
  { nombre: 'Lucía Herrera Vega', subscription: 'cooperativa', role: 'member', zone: 2, status: 'active' },
  { nombre: 'Pedro Sánchez Lara', subscription: 'cooperativa', role: 'member', zone: null, status: 'active' },
  { nombre: 'Rosa Jiménez Cano', subscription: 'free', role: 'member', zone: null, status: 'active' },
  { nombre: 'Javier Molina Prieto', subscription: 'cooperativa', role: 'member', zone: 0, status: 'active' },
  { nombre: 'Ana Reyes Fuentes', subscription: 'corral', role: 'member', zone: 1, status: 'active' },
  { nombre: 'Diego Castro Peña', subscription: 'cooperativa', role: 'member', zone: 2, status: 'active' },
  { nombre: 'Elena Vargas Soto', subscription: 'cooperativa', role: 'member', zone: 0, status: 'inactive' },
  { nombre: 'Miguel Ramos Aguilar', subscription: 'free', role: 'member', zone: null, status: 'active' },
];

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────
function phoneFor(index) {
  return `${DEMO_PHONE_PREFIX}${String(index + 1).padStart(2, '0')}`;
}

function diasAtras(dias) {
  return new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
}

function isoFecha(date) {
  return date.toISOString().slice(0, 10);
}

async function getOrgBySlug(slug) {
  const { data, error } = await supabase
    .from('organizations')
    .select('id, slug, name')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// ──────────────────────────────────────────────────────────────────
// SEED
// ──────────────────────────────────────────────────────────────────
async function seed() {
  console.log(`\n🌱 Sembrando cooperativa demo "${ORG.slug}"...\n`);

  // 1) Organizacion (upsert por slug).
  const existingOrg = await getOrgBySlug(ORG.slug);
  let orgId;
  if (existingOrg) {
    const { error } = await supabase
      .from('organizations')
      .update({ ...ORG, updated_at: new Date().toISOString() })
      .eq('id', existingOrg.id);
    if (error) throw error;
    orgId = existingOrg.id;
    console.log(`  ✓ Organizacion actualizada (id ${orgId})`);
  } else {
    const { data, error } = await supabase
      .from('organizations')
      .insert(ORG)
      .select('id')
      .single();
    if (error) throw error;
    orgId = data.id;
    console.log(`  ✓ Organizacion creada (id ${orgId})`);
  }

  // 2) Staff owner (login del panel). Upsert manual por email (indice unico por lower(email)).
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const { data: existingStaff, error: staffFindErr } = await supabase
    .from('organization_staff')
    .select('id')
    .eq('email', STAFF.email)
    .maybeSingle();
  if (staffFindErr) throw staffFindErr;

  const staffRow = {
    organization_id: orgId,
    email: STAFF.email,
    name: STAFF.name,
    password_hash: passwordHash,
    member_role: STAFF.member_role,
    status: STAFF.status,
    updated_at: new Date().toISOString(),
  };
  if (existingStaff) {
    const { error } = await supabase.from('organization_staff').update(staffRow).eq('id', existingStaff.id);
    if (error) throw error;
    console.log('  ✓ Staff actualizado');
  } else {
    const { error } = await supabase.from('organization_staff').insert(staffRow);
    if (error) throw error;
    console.log('  ✓ Staff creado');
  }

  // 3) Zonas (select-then-insert; el indice unico es por expresion lower(name)).
  const { data: zonasExistentes, error: zonasErr } = await supabase
    .from('organization_zones')
    .select('id, name')
    .eq('organization_id', orgId);
  if (zonasErr) throw zonasErr;

  const zonaIdByName = new Map((zonasExistentes || []).map((z) => [z.name.toLowerCase(), z.id]));
  const zoneIds = [];
  for (const zona of ZONAS) {
    const key = zona.name.toLowerCase();
    if (zonaIdByName.has(key)) {
      const id = zonaIdByName.get(key);
      const { error } = await supabase
        .from('organization_zones')
        .update({ color: zona.color, notes: zona.notes, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
      zoneIds.push(id);
    } else {
      const { data, error } = await supabase
        .from('organization_zones')
        .insert({ organization_id: orgId, ...zona })
        .select('id')
        .single();
      if (error) throw error;
      zoneIds.push(data.id);
    }
  }
  console.log(`  ✓ ${zoneIds.length} zonas`);

  // 4) Socios (users) + 5) organization_members.
  let nuevos = 0;
  const userIds = [];
  for (let i = 0; i < SOCIOS.length; i++) {
    const socio = SOCIOS[i];
    const phone = phoneFor(i);
    const createdAt = diasAtras(i < 4 ? i : 30 + i).toISOString(); // unos pocos en los ultimos 7 dias

    const userRow = {
      phone,
      legal_name: socio.nombre,
      name: socio.nombre.split(' ')[0],
      subscription: socio.subscription,
      organization_id: orgId,
      phone_verified: true,
    };

    const { data: existingUser, error: findErr } = await supabase
      .from('users')
      .select('id')
      .eq('phone', phone)
      .maybeSingle();
    if (findErr) throw findErr;

    let userId;
    if (existingUser) {
      const { error } = await supabase.from('users').update(userRow).eq('id', existingUser.id);
      if (error) throw error;
      userId = existingUser.id;
    } else {
      const { data, error } = await supabase
        .from('users')
        .insert({ ...userRow, created_at: createdAt })
        .select('id')
        .single();
      if (error) throw error;
      userId = data.id;
      nuevos += 1;
    }
    userIds.push(userId);

    // Member (upsert por organization_id,user_id).
    const memberRow = {
      organization_id: orgId,
      user_id: userId,
      role: socio.role,
      status: socio.status,
      zone_id: socio.zone != null ? zoneIds[socio.zone] : null,
      updated_at: new Date().toISOString(),
    };
    const { error: memberErr } = await supabase
      .from('organization_members')
      .upsert(memberRow, { onConflict: 'organization_id,user_id' });
    if (memberErr) throw memberErr;
  }
  console.log(`  ✓ ${SOCIOS.length} socios (${nuevos} nuevos) + members`);

  // 6) Digests recientes (enviado=true) para los primeros 12 socios.
  //    Se reescriben en cada seed: borra los de la org y vuelve a insertar.
  await supabase.from('digests').delete().eq('organization_id', orgId);
  const digestRows = [];
  for (let i = 0; i < Math.min(12, userIds.length); i++) {
    const dia = diasAtras(i % 7);
    const numAlertas = 2 + (i % 3);
    digestRows.push({
      user_id: userIds[i],
      organization_id: orgId,
      fecha: isoFecha(dia),
      mensaje: `Hola, hoy tienes ${numAlertas} ayudas nuevas para tu explotacion. — Olivos del Sur`,
      alerta_ids: Array.from({ length: numAlertas }, (_, k) => 1000 + i * 10 + k),
      enviado: true,
      enviado_at: dia.toISOString(),
      created_at: dia.toISOString(),
    });
  }
  const { error: digestErr } = await supabase.from('digests').insert(digestRows);
  if (digestErr) throw digestErr;
  console.log(`  ✓ ${digestRows.length} digests (ultimos 7 dias)`);

  // 7) Clientes propios (organization_clients). Se reescriben en cada seed.
  //    Si la tabla no existe todavia (migracion sin aplicar), se avisa y se omite.
  const { error: clientsProbe } = await supabase.from('organization_clients').select('id').limit(1);
  if (clientsProbe && MISSING_TABLE_CODES.has(clientsProbe.code)) {
    console.log('  ⚠ organization_clients no existe (aplica la migracion para sembrar clientes); omitido');
  } else {
    if (clientsProbe) throw clientsProbe;
    await supabase.from('organization_clients').delete().eq('organization_id', orgId);
    const clientRows = CLIENTES.map((c, idx) => ({
      organization_id: orgId,
      zone_id: c.zone != null ? zoneIds[c.zone] : null,
      display_name: c.display_name,
      first_name: c.first_name,
      last_name: c.last_name,
      phone: c.phone,
      phone_normalized: c.phone,
      email: c.email,
      status: c.status,
      client_type: c.client_type,
      profile_json: c.profile,
      preferences_json: c.preferences,
      created_at: diasAtras(idx + 1).toISOString(),
    }));
    const { error: clientsErr } = await supabase.from('organization_clients').insert(clientRows);
    if (clientsErr) throw clientsErr;
    console.log(`  ✓ ${clientRows.length} clientes propios`);
  }

  console.log('\n✅ Demo lista. Acceso al panel:');
  console.log(`   slug:     ${ORG.slug}`);
  console.log(`   email:    ${DEMO_STAFF_EMAIL}`);
  console.log(`   password: ${DEMO_PASSWORD}\n`);
}

// ──────────────────────────────────────────────────────────────────
// CLEAN — borra una cooperativa y sus datos
// ──────────────────────────────────────────────────────────────────
async function clean(slug, { purgeUsers }) {
  const org = await getOrgBySlug(slug);
  if (!org) {
    console.log(`\nℹ️  No existe ninguna cooperativa con slug "${slug}". Nada que borrar.\n`);
    return;
  }
  const orgId = org.id;
  console.log(`\n🧹 Borrando cooperativa "${slug}" (id ${orgId})...\n`);

  // Digests de la org.
  await supabase.from('digests').delete().eq('organization_id', orgId);
  console.log('  ✓ digests');

  // Clientes propios (si la tabla existe).
  const { error: clientsDelErr } = await supabase.from('organization_clients').delete().eq('organization_id', orgId);
  if (clientsDelErr && !MISSING_TABLE_CODES.has(clientsDelErr.code)) throw clientsDelErr;
  if (!clientsDelErr) console.log('  ✓ clientes propios');

  // Members y zonas.
  await supabase.from('organization_members').delete().eq('organization_id', orgId);
  await supabase.from('organization_zones').delete().eq('organization_id', orgId);
  console.log('  ✓ members y zonas');

  // Users: borra los demo (telefono DEMO_PHONE_PREFIX) o, si purgeUsers, todos los de la org.
  // Los socios reales (no demo) se DESVINCULAN para no destruir datos de produccion.
  const { data: orgUsers, error: usersErr } = await supabase
    .from('users')
    .select('id, phone')
    .eq('organization_id', orgId);
  if (usersErr) throw usersErr;

  const demoIds = [];
  const realIds = [];
  for (const u of orgUsers || []) {
    if (purgeUsers || String(u.phone || '').startsWith(DEMO_PHONE_PREFIX)) demoIds.push(u.id);
    else realIds.push(u.id);
  }
  if (realIds.length) {
    await supabase.from('users').update({ organization_id: null }).in('id', realIds);
    console.log(`  ✓ ${realIds.length} socios reales desvinculados (no borrados)`);
  }
  if (demoIds.length) {
    await supabase.from('users').delete().in('id', demoIds);
    console.log(`  ✓ ${demoIds.length} socios demo borrados`);
  }

  // Staff y organizacion.
  await supabase.from('organization_staff').delete().eq('organization_id', orgId);
  await supabase.from('organizations').delete().eq('id', orgId);
  console.log('  ✓ staff y organizacion\n');
  console.log('✅ Cooperativa borrada.\n');
}

// ──────────────────────────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const cleanSlugIndex = argv.indexOf('--clean-slug');

  if (argv.includes('--clean')) {
    await clean(DEMO_SLUG, { purgeUsers: true });
  } else if (cleanSlugIndex !== -1) {
    const slug = argv[cleanSlugIndex + 1];
    if (!slug || slug.startsWith('--')) throw new Error('--clean-slug requiere un slug');
    await clean(slug, { purgeUsers: argv.includes('--purge-users') });
  } else {
    await seed();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ Error en seed_partner_demo:', err.message || err);
    process.exit(1);
  });
