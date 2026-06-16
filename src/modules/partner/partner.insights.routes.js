// src/modules/partner/partner.insights.routes.js

const { requireOrg } = require('../../middleware/requireAdmin');

const MISSING_TABLE_CODES = new Set(['42P01', '42703', 'PGRST205']);
const ROLES_INSIGHTS = new Set(['owner', 'admin']);
const EVENT_TYPES = new Set(['page_view', 'panel_click', 'filter_apply', 'action']);

function esTablaNoDisponible(error) {
  return MISSING_TABLE_CODES.has(error?.code);
}

function puedeVerInsights(req) {
  return ROLES_INSIGHTS.has(req.org?.memberRole);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function isoDesdeDias(days) {
  return new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString();
}

function fechaKey(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function crearSerieDiaria(days) {
  const today = new Date();
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today);
    date.setUTCDate(today.getUTCDate() - (days - 1 - index));
    return {
      date: date.toISOString().slice(0, 10),
      clicks: 0,
      digests: 0,
      feedbacks: 0,
    };
  });
}

function safeText(value, fallback = null, max = 240) {
  const text = String(value || '').trim();
  return text ? text.slice(0, max) : fallback;
}

function safeObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function increment(map, key, value = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + value);
}

function hostFromUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return 'sin-destino';
  }
}

function publicUser(user = {}, fallbackId = null) {
  const id = Number(user.id || fallbackId || 0) || null;
  return {
    id,
    name: user.legal_name || user.name || (id ? `Socio ${id}` : 'Socio'),
    phone: user.phone || null,
    email: user.email || null,
    subscription: user.subscription || 'free',
  };
}

function publicClick(click = {}) {
  return {
    id: click.id,
    user_id: click.user_id,
    digest_id: click.digest_id,
    alerta_id: click.alerta_id,
    url_destino: click.url_destino || null,
    created_at: click.created_at || null,
    user: publicUser(click.users, click.user_id),
    alerta: click.alertas
      ? {
          id: click.alertas.id,
          titulo: click.alertas.titulo || null,
          fuente: click.alertas.fuente || null,
        }
      : null,
  };
}

function buildTopAlerts(clicks) {
  const byKey = new Map();
  for (const click of clicks) {
    const key = click.alerta_id || click.url_destino || `click-${click.id}`;
    const current = byKey.get(key) || {
      key,
      alerta_id: click.alerta_id || null,
      titulo: click.alertas?.titulo || click.url_destino || 'Destino sin titulo',
      fuente: click.alertas?.fuente || hostFromUrl(click.url_destino),
      url_destino: click.url_destino || null,
      clicks: 0,
      users: new Set(),
      last_clicked_at: null,
    };
    current.clicks += 1;
    if (click.user_id) current.users.add(Number(click.user_id));
    if (!current.last_clicked_at || click.created_at > current.last_clicked_at) {
      current.last_clicked_at = click.created_at;
    }
    byKey.set(key, current);
  }

  return [...byKey.values()]
    .sort((left, right) => right.clicks - left.clicks)
    .slice(0, 10)
    .map((item) => ({
      key: item.key,
      alerta_id: item.alerta_id,
      titulo: item.titulo,
      fuente: item.fuente,
      url_destino: item.url_destino,
      clicks: item.clicks,
      users: item.users.size,
      last_clicked_at: item.last_clicked_at,
    }));
}

function buildDestinations(clicks) {
  const byHost = new Map();
  for (const click of clicks) increment(byHost, hostFromUrl(click.url_destino));
  return [...byHost.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([host, clicksCount]) => ({ host, clicks: clicksCount }));
}

function sortByCreatedAtDesc(items) {
  return [...items].sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')));
}

function toStringList(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return source.map((item) => String(item || '').trim()).filter(Boolean);
}

function countList(map, labelKey = 'label', valueKey = 'count') {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([label, count]) => ({ [labelKey]: label, [valueKey]: count }));
}

function publicClientInsight(client = {}, zonesById = new Map()) {
  const profile = safeObject(client.profile_json);
  const preferences = safeObject(client.preferences_json);
  const zone = client.zone_id ? zonesById.get(Number(client.zone_id)) : null;

  return {
    id: client.id,
    display_name: client.display_name || 'Cliente',
    status: client.status || 'active',
    client_type: client.client_type || 'cliente',
    zone: zone ? { id: zone.id, name: zone.name, color: zone.color || null } : null,
    profile: {
      province: profile.province || null,
      municipality: profile.municipality || null,
      activity_type: profile.activity_type || null,
      crops: toStringList(profile.crops),
      livestock: toStringList(profile.livestock),
      farm_size: profile.farm_size || null,
    },
    preferences: {
      digest_enabled: preferences.digest_enabled !== false,
      whatsapp_enabled: preferences.whatsapp_enabled !== false,
      email_enabled: Boolean(preferences.email_enabled),
      frequency: preferences.frequency || 'daily',
      topics: toStringList(preferences.topics),
      provinces: toStringList(preferences.provinces),
      lonja_products: toStringList(preferences.lonja_products),
    },
    last_digest_at: client.last_digest_at || null,
    last_interaction_at: client.last_interaction_at || null,
    created_at: client.created_at || null,
  };
}

function buildClientInsights(clients = [], zones = []) {
  const zonesById = new Map((zones || []).map((zone) => [Number(zone.id), zone]));
  const topTopics = new Map();
  const lonjaProducts = new Map();
  const byActivity = new Map();
  const byType = new Map();
  const byStatus = new Map();
  const byZone = new Map();
  const recentlyAdded = sortByCreatedAtDesc(clients)
    .slice(0, 8)
    .map((client) => publicClientInsight(client, zonesById));

  const metrics = {
    total: clients.length,
    active: 0,
    prospects: 0,
    inactive: 0,
    with_digest: 0,
    with_whatsapp: 0,
    with_email: 0,
    with_lonja_products: 0,
    without_zone: 0,
    without_preferences: 0,
  };

  for (const client of clients) {
    const status = client.status || 'active';
    const profile = safeObject(client.profile_json);
    const preferences = safeObject(client.preferences_json);
    const topics = toStringList(preferences.topics);
    const lonjas = toStringList(preferences.lonja_products);

    if (status === 'active') metrics.active += 1;
    else if (status === 'prospect') metrics.prospects += 1;
    else if (status === 'inactive') metrics.inactive += 1;

    if (preferences.digest_enabled !== false) metrics.with_digest += 1;
    if (preferences.whatsapp_enabled !== false) metrics.with_whatsapp += 1;
    if (preferences.email_enabled) metrics.with_email += 1;
    if (lonjas.length) metrics.with_lonja_products += 1;
    if (!client.zone_id) metrics.without_zone += 1;
    if (!topics.length) metrics.without_preferences += 1;

    increment(byStatus, status);
    increment(byType, client.client_type || 'cliente');
    increment(byActivity, profile.activity_type || 'sin-actividad');
    increment(byZone, client.zone_id ? (zonesById.get(Number(client.zone_id))?.name || `Zona ${client.zone_id}`) : 'Sin zona');
    for (const topic of topics) increment(topTopics, topic);
    for (const product of lonjas) increment(lonjaProducts, product);
  }

  return {
    metrics,
    top_topics: countList(topTopics, 'topic', 'clients'),
    lonja_products: countList(lonjaProducts, 'product', 'clients'),
    by_activity: countList(byActivity, 'activity_type', 'clients'),
    by_type: countList(byType, 'client_type', 'clients'),
    by_status: countList(byStatus, 'status', 'clients'),
    by_zone: countList(byZone, 'zone', 'clients'),
    recently_added: recentlyAdded,
  };
}

function buildMemberInsights({ members, memberRows, zones, clicks, feedbacks, digests }) {
  const clicksByUser = new Map();
  const feedbacksByUser = new Map();
  const digestsByUser = new Map();
  const lastClickByUser = new Map();
  const memberByUser = new Map((memberRows || []).map((member) => [Number(member.user_id), member]));
  const zoneById = new Map((zones || []).map((zone) => [Number(zone.id), zone]));

  for (const click of clicks) {
    const userId = Number(click.user_id);
    increment(clicksByUser, userId);
    if (!lastClickByUser.get(userId) || click.created_at > lastClickByUser.get(userId)) {
      lastClickByUser.set(userId, click.created_at);
    }
  }

  for (const feedback of feedbacks) increment(feedbacksByUser, Number(feedback.user_id));
  for (const digest of digests) increment(digestsByUser, Number(digest.user_id));

  return (members || [])
    .map((member) => {
      const userId = Number(member.id);
      const memberRow = memberByUser.get(userId) || {};
      const zone = memberRow.zone_id ? zoneById.get(Number(memberRow.zone_id)) : null;
      const clicksCount = clicksByUser.get(userId) || 0;
      const feedbacksCount = feedbacksByUser.get(userId) || 0;
      const digestsCount = digestsByUser.get(userId) || 0;
      const engagementScore = (clicksCount * 3) + (feedbacksCount * 4) + digestsCount;

      return {
        ...publicUser(member, userId),
        member_role: memberRow.role || null,
        member_status: memberRow.status || null,
        zone: zone ? { id: zone.id, name: zone.name, color: zone.color || null } : null,
        clicks: clicksCount,
        feedbacks: feedbacksCount,
        digests: digestsCount,
        engagement_score: engagementScore,
        last_click_at: lastClickByUser.get(userId) || null,
      };
    })
    .sort((left, right) => right.engagement_score - left.engagement_score)
    .slice(0, 20);
}

async function fetchOrgClicks(supabase, orgId, memberIds, since, limit) {
  const baseSelect = 'id, user_id, digest_id, alerta_id, url_destino, created_at, users(id, name, legal_name, phone, email, subscription), alertas(id, titulo, fuente)';
  const byOrg = await supabase
    .from('alerta_clicks')
    .select(baseSelect)
    .eq('organization_id', orgId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (byOrg.error && !esTablaNoDisponible(byOrg.error)) return byOrg;
  if (!memberIds.length) return byOrg.error ? { data: [], error: byOrg.error } : byOrg;

  const byMembers = await supabase
    .from('alerta_clicks')
    .select(baseSelect)
    .in('user_id', memberIds)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (byMembers.error && byOrg.error) return byMembers;
  if (byMembers.error && !byOrg.error) return byOrg;

  const byId = new Map();
  for (const click of byOrg.error ? [] : byOrg.data || []) byId.set(String(click.id), click);
  for (const click of byMembers.data || []) byId.set(String(click.id), click);

  return {
    data: sortByCreatedAtDesc([...byId.values()]).slice(0, limit),
    error: null,
  };
}

async function fetchOrgRowsByUserIds(supabase, table, select, memberIds, since, limit, dateColumn = 'created_at') {
  if (!memberIds.length) return { data: [], error: null };
  return supabase
    .from(table)
    .select(select)
    .in('user_id', memberIds)
    .gte(dateColumn, since)
    .order(dateColumn, { ascending: false })
    .limit(limit);
}

module.exports = (app, supabase) => {
  app.post('/partner/events', requireOrg, async (req, res) => {
    try {
      const eventType = String(req.body?.event_type || '').trim();
      if (!EVENT_TYPES.has(eventType)) return res.status(400).json({ error: 'event_type invalido' });

      const metadata = safeObject(req.body?.metadata_json || req.body?.metadata);
      const userAgent = String(req.headers['user-agent'] || '').slice(0, 500);
      const { error } = await supabase
        .from('organization_panel_events')
        .insert({
          organization_id: req.org.organizationId,
          staff_id: req.org.impersonatedBy ? null : req.org.staffId,
          event_type: eventType,
          route: safeText(req.body?.route, null, 160),
          target_type: safeText(req.body?.target_type, null, 60),
          target_label: safeText(req.body?.target_label, null, 180),
          target_href: safeText(req.body?.target_href, null, 300),
          metadata_json: metadata,
          user_agent: userAgent,
        });

      if (error) {
        if (esTablaNoDisponible(error)) return res.json({ ok: true, available: false });
        throw error;
      }

      return res.status(201).json({ ok: true, available: true });
    } catch (err) {
      console.error('Error en POST /partner/events:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.get('/partner/insights', requireOrg, async (req, res) => {
    try {
      if (!puedeVerInsights(req)) return res.status(403).json({ error: 'Tu rol no permite ver insights' });

      const orgId = req.org.organizationId;
      const days = clampNumber(req.query.days, 7, 90, 30);
      const limit = clampNumber(req.query.limit, 20, 500, 120);
      const since = isoDesdeDias(days);

      const [{ data: members, error: membersError }, { data: memberRows, error: memberRowsError }, zonesResult, clientsResult] = await Promise.all([
        supabase
          .from('users')
          .select('id, name, legal_name, phone, email, subscription, created_at')
          .eq('organization_id', orgId)
          .order('created_at', { ascending: false }),
        supabase
          .from('organization_members')
          .select('user_id, role, status, zone_id')
          .eq('organization_id', orgId),
        supabase
          .from('organization_zones')
          .select('id, name, color')
          .eq('organization_id', orgId),
        supabase
          .from('organization_clients')
          .select('id, zone_id, display_name, status, client_type, profile_json, preferences_json, last_digest_at, last_interaction_at, created_at')
          .eq('organization_id', orgId)
          .order('created_at', { ascending: false })
          .limit(1000),
      ]);

      if (membersError) throw membersError;
      if (memberRowsError && !esTablaNoDisponible(memberRowsError)) throw memberRowsError;
      if (zonesResult.error && !esTablaNoDisponible(zonesResult.error)) throw zonesResult.error;
      if (clientsResult.error && !esTablaNoDisponible(clientsResult.error)) throw clientsResult.error;

      const safeMembers = members || [];
      const safeClients = clientsResult.error ? [] : clientsResult.data || [];
      const clientInsights = buildClientInsights(safeClients, zonesResult.data || []);
      const memberIds = safeMembers.map((member) => Number(member.id)).filter(Number.isSafeInteger);

      const [clicksResult, feedbacksResult, digestsResult] = await Promise.all([
        fetchOrgClicks(supabase, orgId, memberIds, since, limit * 4),
        fetchOrgRowsByUserIds(
          supabase,
          'alerta_feedback',
          'id, user_id, digest_id, alerta_id, valor, raw_text, created_at, users(id, name, legal_name, phone, email, subscription), alertas(id, titulo, fuente)',
          memberIds,
          since,
          limit * 3
        ),
        fetchOrgRowsByUserIds(
          supabase,
          'digests',
          'id, user_id, fecha, enviado, enviado_at, created_at, alerta_ids',
          memberIds,
          since,
          limit * 3
        ),
      ]);

      for (const result of [clicksResult, feedbacksResult, digestsResult]) {
        if (result.error && !esTablaNoDisponible(result.error)) throw result.error;
      }

      const clicks = clicksResult.error ? [] : clicksResult.data || [];
      const feedbacks = feedbacksResult.error ? [] : feedbacksResult.data || [];
      const digests = digestsResult.error ? [] : digestsResult.data || [];
      const daily = crearSerieDiaria(days);
      const dailyByDate = new Map(daily.map((item) => [item.date, item]));

      for (const click of clicks) {
        const date = fechaKey(click.created_at);
        if (dailyByDate.has(date)) dailyByDate.get(date).clicks += 1;
      }
      for (const feedback of feedbacks) {
        const date = fechaKey(feedback.created_at);
        if (dailyByDate.has(date)) dailyByDate.get(date).feedbacks += 1;
      }
      for (const digest of digests) {
        const date = fechaKey(digest.enviado_at || digest.created_at);
        if (dailyByDate.has(date)) dailyByDate.get(date).digests += 1;
      }

      const uniqueClickers = new Set(clicks.map((click) => Number(click.user_id)).filter(Number.isSafeInteger));
      const activeMembers = (memberRows || []).filter((member) => member.status === 'active').length || safeMembers.length;
      const sentDigests = digests.filter((digest) => digest.enviado).length;

      return res.json({
        ok: true,
        available: {
          clicks: !clicksResult.error,
          feedbacks: !feedbacksResult.error,
          digests: !digestsResult.error,
          clients: !clientsResult.error,
          zones: !zonesResult.error,
        },
        range: {
          days,
          since,
        },
        metrics: {
          members_total: safeMembers.length,
          members_active: activeMembers,
          members_with_clicks: uniqueClickers.size,
          click_rate: safeMembers.length ? uniqueClickers.size / safeMembers.length : 0,
          clients_total: clientInsights.metrics.total,
          clients_active: clientInsights.metrics.active,
          clients_with_digest: clientInsights.metrics.with_digest,
          clients_with_whatsapp: clientInsights.metrics.with_whatsapp,
          clients_without_preferences: clientInsights.metrics.without_preferences,
          clicks_total: clicks.length,
          feedback_total: feedbacks.length,
          digests_sent: sentDigests,
        },
        clients: clientInsights,
        daily,
        top_alerts: buildTopAlerts(clicks),
        top_destinations: buildDestinations(clicks),
        member_insights: buildMemberInsights({
          members: safeMembers,
          memberRows: memberRows || [],
          zones: zonesResult.data || [],
          clicks,
          feedbacks,
          digests,
        }),
        recent_clicks: clicks.slice(0, limit).map(publicClick),
      });
    } catch (err) {
      console.error('Error en GET /partner/insights:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
