# Partner

API multi-tenant para cooperativas y organizaciones. Todas las consultas parten del tenant autenticado y sirven a `ruralicos-partner`.

## Archivos

| Archivo | Área |
| --- | --- |
| `partner.auth.routes.js` | Branding público, login y sesión |
| `partner.data.routes.js` | Overview, miembros, digests y branding |
| `partner.clients.routes.js` | Clientes/socios propios |
| `partner.zones.routes.js` | Zonas territoriales |
| `partner.insights.routes.js` | Eventos y analítica |
| `partner.plan.routes.js` | Consulta/solicitud de plan |
| `partner.staff.routes.js` | Personal e impersonación desde admin |
| `tenantClient.js` | Contexto y aislamiento de organización |

## Aislamiento

La regla principal es: `organization_id` viene del token, no del body ni de un filtro libre. Para operaciones por ID:

1. resolver el tenant autenticado;
2. consultar el recurso dentro de ese tenant;
3. autorizar por rol/capacidad;
4. mutar usando ambas condiciones;
5. devolver `404`/`403` sin revelar existencia ajena.

## Datos

- `organization_members`: usuarios finales asociados a la entidad.
- `organization_staff`: personas con acceso al panel.
- `organization_clients`: cartera gestionada por la organización.
- `organization_zones`: ámbitos configurados.
- `partner_panel_events`: telemetría permitida.
- `organizations`: marca, configuración y plan.

La migración concreta puede evolucionar; consultar `supabase/migrations`.

## Impersonación

Solo un admin de Ruralicos puede emitirla. Debe:

- ser corta;
- quedar auditada;
- indicar en token y UI que es impersonación;
- no conceder más permisos que el rol previsto;
- invalidarse con la versión de credenciales cuando aplique.

## Pruebas

`partnerTenantIsolation.test.js`, `tenantClient.test.js` y pruebas manuales con dos organizaciones distintas.
