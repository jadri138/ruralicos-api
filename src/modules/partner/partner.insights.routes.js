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
      panel_events: 0,
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

function publicPanelEvent(event = {}) {
  return {
    id: event.id,
    event_type: event.event_type,
    route: event.route || null,
    target_type: event.target_type || null,
    target_label: event.target_label || null,
    target_href: event.target_href || null,
    staff_id: event.staff_id || null,
    created_at: event.created_at || null,
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

function buildPanelUsage(events) {
  const byRoute = new Map();
  const byTarget = new Map();
  for (const event of events) {
    increment(byRoute, event.route || 'sin-ruta');
    if (event.event_type === 'panel_click') {
      const label = event.target_label || event.target_href || event.target_type || 'click';
      increment(byTarget, label);
    }
  }

  return {
    by_route: [...byRoute.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([route, eventsCount]) => ({ route, events: eventsCount })),
    top_clicks: [...byTarget.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 10)
      .map(([label, clicks]) => ({ label, clicks })),
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
  let query = supabase
    .from('alerta_clicks')
    .select(baseSelect)
    .eq('organization_id', orgId)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  let result = await query;
  if (!result.error) return result;
  if (!esTablaNoDisponible(result.error) || !memberIds.length) return result;

  result = await supabase
    .from('alerta_clicks')
    .select(baseSelect)
    .in('user_id', memberIds)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(limit);
  return result;
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

      const [{ data: members, error: membersError }, { data: memberRows, error: memberRowsError }, zonesResult] = await Promise.all([
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
      ]);

      if (membersError) throw membersError;
      if (memberRowsError && !esTablaNoDisponible(memberRowsError)) throw memberRowsError;
      if (zonesResult.error && !esTablaNoDisponible(zonesResult.error)) throw zonesResult.error;

      const safeMembers = members || [];
      const memberIds = safeMembers.map((member) => Number(member.id)).filter(Number.isSafeInteger);

      const [clicksResult, feedbacksResult, digestsResult, panelEventsResult] = await Promise.all([
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
        supabase
          .from('organization_panel_events')
          .select('id, staff_id, event_type, route, target_type, target_label, target_href, created_at')
          .eq('organization_id', orgId)
          .gte('created_at', since)
          .order('created_at', { ascending: false })
          .limit(limit * 4),
      ]);

      for (const result of [clicksResult, feedbacksResult, digestsResult, panelEventsResult]) {
        if (result.error && !esTablaNoDisponible(result.error)) throw result.error;
      }

      const clicks = clicksResult.error ? [] : clicksResult.data || [];
      const feedbacks = feedbacksResult.error ? [] : feedbacksResult.data || [];
      const digests = digestsResult.error ? [] : digestsResult.data || [];
      const panelEvents = panelEventsResult.error ? [] : panelEventsResult.data || [];
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
      for (const event of panelEvents) {
        const date = fechaKey(event.created_at);
        if (dailyByDate.has(date)) dailyByDate.get(date).panel_events += 1;
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
          panel_events: !panelEventsResult.error,
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
          clicks_total: clicks.length,
          feedback_total: feedbacks.length,
          digests_sent: sentDigests,
          panel_events_total: panelEvents.length,
          panel_clicks_total: panelEvents.filter((event) => event.event_type === 'panel_click').length,
        },
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
        panel_usage: buildPanelUsage(panelEvents),
        recent_panel_events: panelEvents.slice(0, limit).map(publicPanelEvent),
      });
    } catch (err) {
      console.error('Error en GET /partner/insights:', err);
      return res.status(500).json({ error: err.message });
    }
  });
};
