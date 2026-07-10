// src/modules/partner/tenantClient.js
//
// Cliente Supabase con el filtro de tenant (organization_id) forzado en UN
// unico sitio. Las rutas del panel partner (requireOrg) no deben repetir
// `.eq('organization_id', orgId)` a mano en cada query: un solo `.eq()`
// olvidado seria una fuga de datos entre cooperativas, y la BD no protege
// (el backend usa la service-role key, que salta el RLS).
//
// Uso:
//   const db = orgClient(supabase, req);          // tras requireOrg
//   db.from('users').select('id, name');           // + eq(organization_id) automatico
//   db.from('organization_zones').insert({ ... }); // organization_id sellado
//
// Consultas fuera del tenant (deliberadas y auditables con un grep):
//   db.sinTenant.from('users')...  // p.ej. buscar un usuario global por telefono
//
// Una tabla que no este en el registro lanza error: obliga a decidir de forma
// explicita si la nueva tabla se filtra por tenant o se accede via sinTenant.

// tabla -> columna de tenant. `organizations` es el tenant mismo: filtra por id
// y no admite insert/upsert/delete desde el panel de la cooperativa.
const TENANT_TABLES = {
  users: 'organization_id',
  digests: 'organization_id',
  alerta_clicks: 'organization_id',
  alerta_click_links: 'organization_id',
  alerta_feedback: 'organization_id',
  organization_members: 'organization_id',
  organization_zones: 'organization_id',
  organization_clients: 'organization_id',
  organization_staff: 'organization_id',
  organization_panel_events: 'organization_id',
  organizations: 'id',
};

const SOLO_LECTURA_Y_UPDATE = new Set(['organizations']);

function crearTenantClient(supabase, organizationId) {
  const orgId = Number(organizationId);
  if (!Number.isSafeInteger(orgId) || orgId <= 0) {
    throw new Error(`[tenantClient] organizationId invalido: ${organizationId}`);
  }

  function sellar(values, columna) {
    if (Array.isArray(values)) return values.map((row) => ({ ...row, [columna]: orgId }));
    return { ...values, [columna]: orgId };
  }

  return {
    organizationId: orgId,
    sinTenant: supabase,

    from(table) {
      const columna = TENANT_TABLES[table];
      if (!columna) {
        throw new Error(
          `[tenantClient] tabla "${table}" sin columna de tenant registrada. ` +
          'Anadela a TENANT_TABLES o usa sinTenant de forma explicita.'
        );
      }

      const base = supabase.from(table);
      const soloLecturaYUpdate = SOLO_LECTURA_Y_UPDATE.has(table);

      return {
        select: (...args) => base.select(...args).eq(columna, orgId),
        update: (values, ...args) => base.update(values, ...args).eq(columna, orgId),
        delete: (...args) => {
          if (soloLecturaYUpdate) {
            throw new Error(`[tenantClient] delete no permitido en "${table}" desde el panel partner`);
          }
          return base.delete(...args).eq(columna, orgId);
        },
        insert: (values, ...args) => {
          if (soloLecturaYUpdate) {
            throw new Error(`[tenantClient] insert no permitido en "${table}" desde el panel partner`);
          }
          return base.insert(sellar(values, columna), ...args);
        },
        upsert: (values, ...args) => {
          if (soloLecturaYUpdate) {
            throw new Error(`[tenantClient] upsert no permitido en "${table}" desde el panel partner`);
          }
          return base.upsert(sellar(values, columna), ...args);
        },
      };
    },
  };
}

// Azucar para handlers tras requireOrg: el orgId sale del token verificado.
function orgClient(supabase, req) {
  return crearTenantClient(supabase, req?.org?.organizationId);
}

module.exports = {
  TENANT_TABLES,
  crearTenantClient,
  orgClient,
};
