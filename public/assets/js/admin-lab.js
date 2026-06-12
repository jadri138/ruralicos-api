(() => {
  'use strict';

  const SESSION_KEY = 'ruralicos.digestLab.session.v1';
  const elements = {};
  const state = {
    preview: null,
    diagnostic: null,
    userInspector: null,
    overview: null,
    lastEnvelope: null,
  };

  function query(selector) {
    return document.querySelector(selector);
  }

  function createElement(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function todayMadrid() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());

    const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${lookup.year}-${lookup.month}-${lookup.day}`;
  }

  function cleanBaseUrl(value) {
    return String(value || window.location.origin || '')
      .trim()
      .replace(/\/+$/, '');
  }

  function getAuthMode() {
    const selected = document.querySelector('input[name="authMode"]:checked');
    return selected ? selected.value : 'cron';
  }

  function getConfig() {
    return {
      baseUrl: cleanBaseUrl(elements.apiBase.value),
      mode: getAuthMode(),
      secret: elements.secret.value.trim(),
      remember: elements.rememberSecret.checked,
    };
  }

  function getSubjectParams(options = {}) {
    const includeName = options.includeName !== false;
    const userId = elements.userId.value.trim();
    const phone = elements.phone.value.trim();
    const name = elements.nameQuery.value.trim();
    const params = {};

    if (/^\d+$/.test(userId)) params.user_id = userId;
    if (phone) params.phone = phone;
    if (includeName && name) params.name = name;

    return params;
  }

  function getRunParams() {
    return {
      fecha: elements.fecha.value || todayMadrid(),
      ia: String(elements.useIa.checked),
      rescate: String(elements.useRescate.checked),
    };
  }

  function saveSessionIfNeeded() {
    const config = getConfig();
    if (!config.remember) {
      sessionStorage.removeItem(SESSION_KEY);
      return;
    }

    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      baseUrl: config.baseUrl,
      mode: config.mode,
      secret: config.secret,
      remember: true,
    }));
  }

  function restoreSession() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || '{}');
      if (!saved || !saved.remember) return;
      if (saved.baseUrl) elements.apiBase.value = saved.baseUrl;
      if (saved.secret) elements.secret.value = saved.secret;
      if (saved.mode) {
        const radio = document.querySelector(`input[name="authMode"][value="${saved.mode}"]`);
        if (radio) radio.checked = true;
      }
      elements.rememberSecret.checked = true;
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
    }
  }

  function buildUrl(path, params = {}) {
    const config = getConfig();
    const url = new URL(path, `${config.baseUrl}/`);
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, value);
      }
    });
    return url;
  }

  async function fetchJson(path, options = {}) {
    const config = getConfig();
    if (!config.baseUrl) throw new Error('Falta URL de la API');
    if (!config.secret) throw new Error('Falta token/JWT');

    const params = { ...(options.params || {}) };
    const headers = { Accept: 'application/json' };
    const method = options.method || 'GET';
    let body = null;

    if (config.mode === 'jwt' || options.admin) {
      headers.Authorization = `Bearer ${config.secret}`;
    } else {
      params.token = config.secret;
    }

    if (options.body && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const response = await fetch(buildUrl(path, params), { method, headers, body });
    const rawText = await response.text();
    let data = {};
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch {
        data = { raw: rawText };
      }
    }

    if (!response.ok) {
      const error = new Error(data.error || data.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  function setBusy(isBusy) {
    [
      elements.btnSearch,
      elements.btnPreview,
      elements.btnDiagnose,
      elements.btnOverview,
      elements.btnCopy,
      elements.btnDownload,
      elements.btnClear,
      elements.btnClearUser,
    ].forEach((button) => {
      if (button) button.disabled = isBusy;
    });
  }

  async function withBusy(task) {
    setBusy(true);
    try {
      await task();
      saveSessionIfNeeded();
    } finally {
      setBusy(false);
    }
  }

  function showStatus(kind, title, detail) {
    elements.statusBanner.className = `status-banner ${kind || ''}`.trim();
    elements.statusBanner.replaceChildren(
      createElement('strong', '', title || 'Listo'),
      createElement('span', '', detail || '')
    );
  }

  function clearNode(node, emptyText) {
    node.replaceChildren();
    if (emptyText) {
      node.appendChild(createElement('div', 'empty-note', emptyText));
    }
  }

  function textValue(value, fallback = '—') {
    if (value === undefined || value === null || value === '') return fallback;
    if (Array.isArray(value)) return value.length ? value.join(', ') : fallback;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function truncate(value, maxLength = 140) {
    const text = textValue(value, '');
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1).trim()}…`;
  }

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return textValue(value);
    if (Math.abs(number) < 1 && number !== 0) return number.toFixed(3);
    if (!Number.isInteger(number)) return number.toFixed(2);
    return String(number);
  }

  function badgeTone(keyOrLabel) {
    const text = String(keyOrLabel || '').toLowerCase();
    if (text.includes('urgente') || text.includes('alta') || text.includes('error')) return 'red';
    if (text.includes('revis') || text.includes('baja') || text.includes('warn')) return 'yellow';
    if (text.includes('ok') || text.includes('media') || text.includes('normal') || text.includes('dry')) return 'green';
    return '';
  }

  function createBadge(text, tone) {
    return createElement('span', `badge ${tone || badgeTone(text)}`.trim(), textValue(text));
  }

  function createChip(text, tone) {
    return createElement('span', `chip ${tone || badgeTone(text)}`.trim(), textValue(text));
  }

  function appendInfo(parent, label, value) {
    const line = createElement('div', 'info-line');
    line.appendChild(createElement('span', '', label));
    line.appendChild(createElement('p', '', textValue(value)));
    parent.appendChild(line);
  }

  function renderMetrics() {
    const preview = state.preview;
    const counters = preview?.contadores || {};
    const safeWrites = Array.isArray(preview?.writes) ? preview.writes.length : '—';
    const safeSends = Array.isArray(preview?.sends) ? preview.sends.length : '—';
    const metrics = preview ? [
      ['Modo', preview.dry_run ? 'Dry-run' : 'Revisar'],
      ['Writes BD', safeWrites],
      ['WhatsApps', safeSends],
      ['Alertas finales', counters.alertas_finales ?? 0],
      ['Plan', preview.plan],
      ['Generador', preview.generador],
      ['Origen', preview.origen],
      ['Motivo no envío', preview.motivo_no_envio || '—'],
      ['Alertas día', counters.alertas_dia_total ?? '—'],
      ['Quality gate', counters.tras_quality_gate ?? '—'],
      ['Filtro usuario', counters.tras_filtro_usuario ?? '—'],
      ['Descartadas calidad', counters.descartadas_calidad ?? '—'],
    ] : [
      ['Modo', 'Sin ejecutar'],
      ['Writes BD', '—'],
      ['WhatsApps', '—'],
      ['Alertas finales', '—'],
    ];

    elements.metricGrid.replaceChildren();
    metrics.forEach(([label, value]) => {
      const metric = createElement('div', 'metric');
      metric.appendChild(createElement('span', '', label));
      metric.appendChild(createElement('strong', '', textValue(value)));
      elements.metricGrid.appendChild(metric);
    });
  }

  function renderMessage() {
    const preview = state.preview;
    const message = preview?.mensaje || '';
    elements.messagePreview.className = `message-preview ${message ? '' : 'empty'}`.trim();
    elements.messagePreview.textContent = message || 'Aquí aparecerá el mensaje. No se manda a nadie.';
    elements.messageMeta.textContent = preview ? `${preview.generador || 'generador'} · ${preview.fecha || ''}` : 'Sin preview';
  }

  function groupAlerts(alerts) {
    const groups = new Map();
    (alerts || []).forEach((alert) => {
      const label = alert.grupo || alert.contexto_mia_digest?.grupo_label || 'Sin grupo';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(alert);
    });
    return [...groups.entries()];
  }

  function humanizeCoincidences(coincidences = {}) {
    const parts = Object.entries(coincidences)
      .filter(([, values]) => Array.isArray(values) && values.length > 0)
      .map(([key, values]) => `${key.replace(/_/g, ' ')}: ${values.join(', ')}`);
    return parts.length ? parts.join('; ') : 'Sin coincidencias textuales fuertes.';
  }

  function renderAlertCard(alert) {
    const context = alert.contexto_mia_digest || {};
    const message = context.mensaje || {};
    const selection = context.seleccion || {};
    const diagnostic = context.diagnostico_usuario || {};
    const temporal = context.temporal || {};

    const card = createElement('article', 'alert-card');
    const top = createElement('div', 'alert-top');
    const titleBox = createElement('div', 'alert-title');
    titleBox.appendChild(createElement('strong', '', `${alert.item_numero || '?'} · ${alert.titulo_facil || alert.titulo || 'Alerta'}`));
    titleBox.appendChild(createElement('small', '', alert.titulo || `Alerta ${alert.id || ''}`));

    const badges = createElement('div', 'badges');
    badges.appendChild(createBadge(alert.grupo || context.grupo_label || 'Sin grupo'));
    badges.appendChild(createBadge(alert.relevancia || context.relevancia_label || 'Normal'));
    if (selection.modo) badges.appendChild(createBadge(selection.modo));
    if (selection.tipo_rescate) badges.appendChild(createBadge(`rescate ${selection.tipo_rescate}`, 'yellow'));

    top.appendChild(titleBox);
    top.appendChild(badges);
    card.appendChild(top);

    const fields = createElement('div', 'field-list');
    appendInfo(fields, 'Por qué a este usuario', context.motivo_usuario);
    appendInfo(fields, 'En sencillo', message.resumen_facil);
    appendInfo(fields, 'Qué miraría', message.accion_sugerida);
    appendInfo(fields, 'Coincidencias', humanizeCoincidences(context.coincidencias));
    appendInfo(fields, 'Diagnóstico usuario', `${diagnostic.ok ? 'ok' : 'revisar'} · ${diagnostic.motivo || 'sin motivo'} · ${diagnostic.detalle || 'sin detalle'}`);
    appendInfo(fields, 'Selección interna', [
      selection.origen ? `origen: ${selection.origen}` : null,
      selection.prioridad ? `prioridad: ${selection.prioridad}` : null,
      selection.prioridad_score !== null && selection.prioridad_score !== undefined ? `score prioridad: ${formatNumber(selection.prioridad_score)}` : null,
      selection.similitud !== null && selection.similitud !== undefined ? `similitud: ${formatNumber(selection.similitud)}` : null,
      selection.mia_profile_score !== null && selection.mia_profile_score !== undefined ? `perfil: ${formatNumber(selection.mia_profile_score)}` : null,
    ].filter(Boolean).join(' · '));
    appendInfo(fields, 'Motivos de prioridad', selection.prioridad_motivos);
    appendInfo(fields, 'Tiempo/plazo', [
      temporal.fecha_alerta ? `alerta: ${temporal.fecha_alerta}` : null,
      temporal.fecha_digest ? `digest: ${temporal.fecha_digest}` : null,
      temporal.plazo_detectado ? `plazo: ${temporal.plazo_detectado}` : null,
      temporal.rescate_desde ? `rescate desde: ${temporal.rescate_desde}` : null,
    ].filter(Boolean).join(' · '));
    card.appendChild(fields);

    if (alert.url) {
      const linkLine = createElement('div', 'info-line');
      linkLine.appendChild(createElement('span', '', 'Enlace oficial'));
      const link = createElement('a', '', alert.url);
      link.href = alert.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      linkLine.appendChild(link);
      fields.appendChild(linkLine);
    }

    const details = createElement('details');
    details.appendChild(createElement('summary', '', 'Ver contexto JSON completo'));
    const pre = createElement('pre', 'code', JSON.stringify(context, null, 2));
    details.appendChild(pre);
    card.appendChild(details);

    return card;
  }

  function renderAlerts() {
    const alerts = state.preview?.alertas || [];
    clearNode(elements.alertsContainer);

    if (!alerts.length) {
      clearNode(elements.alertsContainer, 'No hay alertas finales en este preview.');
      return;
    }

    groupAlerts(alerts).forEach(([groupLabel, groupAlertsList]) => {
      const group = createElement('section', 'group');
      const title = createElement('div', 'group-title');
      title.appendChild(createElement('h3', '', groupLabel));
      title.appendChild(createBadge(`${groupAlertsList.length} alerta${groupAlertsList.length === 1 ? '' : 's'}`, 'green'));
      group.appendChild(title);

      groupAlertsList.forEach((alert) => group.appendChild(renderAlertCard(alert)));
      elements.alertsContainer.appendChild(group);
    });
  }

  function renderSuggestions(suggestions = []) {
    clearNode(elements.suggestions);
    if (!suggestions.length) return;

    suggestions.forEach((suggestion) => {
      const row = createElement('div', 'suggestion');
      const info = createElement('div');
      info.appendChild(createElement('strong', '', `${suggestion.name || 'Sin nombre'} · ID ${suggestion.id}`));
      info.appendChild(createElement('p', '', `${suggestion.phone || 'sin teléfono'} · ${suggestion.email || 'sin email'} · ${suggestion.subscription || 'sin plan'}`));

      const button = createElement('button', 'btn secondary', 'Elegir');
      button.type = 'button';
      button.addEventListener('click', async () => {
        elements.userId.value = suggestion.id || '';
        elements.phone.value = suggestion.phone || '';
        elements.nameQuery.value = suggestion.name || '';
        await withBusy(loadUserInspector).catch(showError);
      });

      row.appendChild(info);
      row.appendChild(button);
      elements.suggestions.appendChild(row);
    });
  }

  function handleKnownError(error) {
    if (error.status === 409 && error.data?.suggestions) {
      renderSuggestions(error.data.suggestions);
      showStatus('warn', 'Hay varios usuarios.', 'Elige uno de la lista y repite la prueba.');
      return true;
    }
    return false;
  }

  function renderDiagnostic(data) {
    state.diagnostic = data || null;
    clearNode(elements.diagnosticContainer);

    if (!data) {
      clearNode(elements.diagnosticContainer, 'Aún no has lanzado el diagnóstico.');
      updateRawJson();
      return;
    }

    const header = createElement('div', 'mini-card');
    const chips = createElement('div', 'chip-row');
    chips.appendChild(createChip(`fecha: ${data.fecha || '—'}`, 'green'));
    if (data.plan) chips.appendChild(createChip(`plan: ${data.plan}`));
    if (data.user?.id) chips.appendChild(createChip(`user: ${data.user.id}`));
    Object.entries(data.resumen || {}).forEach(([key, value]) => {
      chips.appendChild(createChip(`${key}: ${value}`, key === 'incluidas' ? 'green' : 'yellow'));
    });
    header.appendChild(chips);
    elements.diagnosticContainer.appendChild(header);

    const detail = Array.isArray(data.detalle) ? data.detalle : [];
    if (!detail.length) {
      elements.diagnosticContainer.appendChild(createElement('div', 'empty-note', 'El diagnóstico no trae detalle de alertas.'));
      updateRawJson();
      return;
    }

    const tableCard = createElement('div', 'mini-card');
    const table = createElement('table', 'mini-table');
    const thead = createElement('thead');
    const headRow = createElement('tr');
    ['Estado', 'Alerta', 'Motivo', 'Riesgo', 'Calidad'].forEach((label) => headRow.appendChild(createElement('th', '', label)));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = createElement('tbody');
    detail.forEach((item) => {
      const row = createElement('tr');
      row.appendChild(createElement('td', '', item.incluida ? 'Incluida' : 'Fuera'));
      row.appendChild(createElement('td', '', `${item.id || '—'} · ${truncate(item.titulo, 110)}`));
      row.appendChild(createElement('td', '', `${item.motivo || '—'} · ${truncate(item.detalle, 100)}`));
      row.appendChild(createElement('td', '', item.riesgo || '—'));
      row.appendChild(createElement('td', '', typeof item.calidad === 'object' ? truncate(JSON.stringify(item.calidad), 120) : textValue(item.calidad)));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableCard.appendChild(table);
    elements.diagnosticContainer.appendChild(tableCard);
    updateRawJson();
  }

  function renderUserInspector(data) {
    if (data) state.userInspector = data;
    clearNode(elements.userInspector);

    const inspector = state.userInspector;
    if (!inspector?.user) {
      clearNode(elements.userInspector, 'Busca un usuario con JWT admin para ver su perfil MIA completo.');
      updateRawJson();
      return;
    }

    const user = inspector.user;
    const summary = createElement('div', 'mini-card');
    summary.appendChild(createElement('h3', '', user.legal_name || user.name || `Usuario ${user.id}`));
    const chips = createElement('div', 'chip-row');
    chips.appendChild(createChip(`ID ${user.id}`, 'green'));
    chips.appendChild(createChip(user.subscription || 'sin plan'));
    chips.appendChild(createChip(user.phone || 'sin teléfono'));
    if (user.organization_id) chips.appendChild(createChip(`org ${user.organization_id}`));
    if (user.perfil_actualizado_at) chips.appendChild(createChip(`perfil ${new Date(user.perfil_actualizado_at).toLocaleString()}`));
    summary.appendChild(chips);
    appendInfo(summary, 'Preferencias', user.preferences ? JSON.stringify(user.preferences) : '—');
    appendInfo(summary, 'Preferencias extra', user.preferencias_extra || '—');
    appendInfo(summary, 'Contexto narrativo', user.contexto_narrativo || '—');
    elements.userInspector.appendChild(summary);

    renderTagBlock('Tags positivos', inspector.tags?.positivos || [], 'green');
    renderTagBlock('Tags negativos', inspector.tags?.negativos || [], 'yellow');
    renderCompactTable('Feedback reciente', inspector.feedbacks || [], [
      ['item', 'item_numero'],
      ['valor', 'valor'],
      ['texto', 'raw_text'],
      ['fecha', 'created_at'],
    ]);
    renderCompactTable('Digests recientes', inspector.digests || [], [
      ['id', 'id'],
      ['fecha', 'fecha'],
      ['enviado', 'enviado'],
      ['error', 'error_msg'],
    ]);
    renderCompactTable('Exploraciones', inspector.exploracion || [], [
      ['alerta', 'alerta_id'],
      ['tipo', 'tipo_exploracion'],
      ['resultado', 'resultado'],
      ['fecha', 'created_at'],
    ]);
    updateRawJson();
  }

  function renderTagBlock(title, tags, tone) {
    const card = createElement('div', 'mini-card');
    card.appendChild(createElement('h3', '', title));
    const row = createElement('div', 'chip-row');
    if (!tags.length) {
      row.appendChild(createChip('sin datos'));
    } else {
      tags.slice(0, 22).forEach((tag) => {
        row.appendChild(createChip(`${tag.tag}: ${formatNumber(tag.score)}`, tone));
      });
    }
    card.appendChild(row);
    elements.userInspector.appendChild(card);
  }

  function renderCompactTable(title, rows, columns) {
    const card = createElement('div', 'mini-card');
    card.appendChild(createElement('h3', '', title));

    if (!rows.length) {
      card.appendChild(createElement('p', 'muted', 'Sin datos recientes.'));
      elements.userInspector.appendChild(card);
      return;
    }

    const table = createElement('table', 'mini-table');
    const thead = createElement('thead');
    const headRow = createElement('tr');
    columns.forEach(([label]) => headRow.appendChild(createElement('th', '', label)));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = createElement('tbody');
    rows.slice(0, 8).forEach((rowData) => {
      const row = createElement('tr');
      columns.forEach(([, key]) => row.appendChild(createElement('td', '', truncate(rowData[key], 100))));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    card.appendChild(table);
    elements.userInspector.appendChild(card);
  }

  function renderOverview(results) {
    if (results) state.overview = results;
    clearNode(elements.overviewBox);

    const overview = state.overview;
    if (!overview) {
      clearNode(elements.overviewBox, 'Pulsa “Cargar estado MIA” con JWT admin para ver salud operativa.');
      updateRawJson();
      return;
    }

    const mia = overview.mia;
    const health = overview.health;

    const miaCard = createElement('div', 'mini-card');
    miaCard.appendChild(createElement('h3', '', 'MIA overview'));
    if (mia?.ok === false) {
      miaCard.appendChild(createElement('p', 'muted', mia.error || 'No disponible'));
    } else {
      const chips = createElement('div', 'chip-row');
      [
        ['usuarios', mia?.usuarios_totales],
        ['con perfil', mia?.usuarios_con_perfil_embedding],
        ['sin perfil', mia?.usuarios_sin_perfil_embedding],
        ['memorias hoy', mia?.memorias_hoy],
        ['feedback hoy', mia?.feedback_hoy],
        ['clicks hoy', mia?.clicks_hoy],
        ['exploraciones pendientes', mia?.exploraciones_pendientes],
      ].forEach(([label, value]) => chips.appendChild(createChip(`${label}: ${textValue(value)}`, 'green')));
      miaCard.appendChild(chips);
    }
    elements.overviewBox.appendChild(miaCard);

    const healthCard = createElement('div', 'mini-card');
    healthCard.appendChild(createElement('h3', '', 'Health deep'));
    if (health?.ok === false) {
      healthCard.appendChild(createElement('p', 'muted', health.error || 'No disponible'));
    } else {
      const chips = createElement('div', 'chip-row');
      Object.entries(health || {}).slice(0, 14).forEach(([key, value]) => {
        if (typeof value !== 'object') chips.appendChild(createChip(`${key}: ${textValue(value)}`));
      });
      healthCard.appendChild(chips);
    }
    elements.overviewBox.appendChild(healthCard);
    updateRawJson();
  }

  function renderPreview(preview, envelope) {
    state.preview = preview || null;
    state.lastEnvelope = envelope || null;

    if (!preview) {
      showStatus('warn', 'Sin preview.', 'La API no devolvió resultado de preview.');
      renderAll();
      return;
    }

    const writes = Array.isArray(preview.writes) ? preview.writes.length : null;
    const sends = Array.isArray(preview.sends) ? preview.sends.length : null;
    const safe = preview.dry_run === true && writes === 0 && sends === 0;

    showStatus(
      safe ? 'success' : 'warn',
      safe ? 'Preview seguro verificado.' : 'Preview generado, revisa seguridad.',
      `dry_run=${preview.dry_run} · writes=${textValue(writes)} · sends=${textValue(sends)} · ${preview.aviso || ''}`
    );
    renderAll();
  }

  function renderAll() {
    renderMetrics();
    renderMessage();
    renderAlerts();
    renderDiagnostic(state.diagnostic);
    renderUserInspector(state.userInspector);
    renderOverview(state.overview);
    updateRawJson();
  }

  function updateRawJson() {
    const payload = {
      preview: state.preview,
      diagnostic: state.diagnostic,
      userInspector: state.userInspector,
      overview: state.overview,
      envelope: state.lastEnvelope,
    };
    elements.rawJson.textContent = JSON.stringify(payload, null, 2);
  }

  async function loadUserInspector() {
    if (getAuthMode() !== 'jwt') {
      showStatus('warn', 'Búsqueda limitada.', 'Con token de pruebas no se puede listar usuarios; usa ID o teléfono y lanza preview.');
      return;
    }

    const params = getSubjectParams();
    if (!params.user_id && !params.phone && !params.name) {
      throw new Error('Indica ID, teléfono o nombre para buscar.');
    }

    try {
      const data = await fetchJson('/admin/mia/user', { params, admin: true });
      renderSuggestions([]);
      renderUserInspector(data);
      elements.userId.value = data.user?.id || elements.userId.value;
      elements.phone.value = data.user?.phone || elements.phone.value;
      elements.nameQuery.value = data.user?.legal_name || data.user?.name || elements.nameQuery.value;
      showStatus('success', 'Usuario cargado.', `ID ${data.user?.id} · ${data.user?.subscription || 'sin plan'}`);
    } catch (error) {
      if (!handleKnownError(error)) throw error;
    }
  }

  async function runPreview() {
    const config = getConfig();
    const runParams = getRunParams();

    if (config.mode === 'cron') {
      const subject = getSubjectParams({ includeName: false });
      if (!subject.user_id && !subject.phone) {
        throw new Error('Con token de pruebas necesitas user_id o teléfono. Para buscar por nombre usa JWT admin.');
      }

      const preview = await fetchJson('/alertas/preview-digest', {
        params: { ...subject, ...runParams },
      });
      renderPreview(preview, preview);
      return;
    }

    const subject = getSubjectParams();
    if (!subject.user_id && !subject.phone && !subject.name) {
      throw new Error('Indica user_id, teléfono o nombre.');
    }

    try {
      const envelope = await fetchJson('/admin/mia/dry-run-digest', {
        method: 'POST',
        admin: true,
        body: { ...subject, ...runParams },
      });

      if (envelope.user) {
        state.userInspector = state.userInspector || { user: envelope.user };
        elements.userId.value = envelope.user.id || elements.userId.value;
        elements.phone.value = envelope.user.phone || elements.phone.value;
        elements.nameQuery.value = envelope.user.name || elements.nameQuery.value;
      }
      renderSuggestions([]);
      renderPreview(envelope.preview || envelope, envelope);
    } catch (error) {
      if (!handleKnownError(error)) throw error;
    }
  }

  async function runDiagnostic() {
    const config = getConfig();
    const runParams = getRunParams();

    if (config.mode === 'cron') {
      const subject = getSubjectParams({ includeName: false });
      if (!subject.user_id && !subject.phone) {
        throw new Error('Con token de pruebas necesitas user_id o teléfono para diagnosticar.');
      }
      const diagnostic = await fetchJson('/alertas/diagnosticar-digest', {
        params: { ...subject, fecha: runParams.fecha },
      });
      renderDiagnostic(diagnostic);
      showStatus('success', 'Diagnóstico cargado.', 'Revisa incluidas/descartadas en la sección de filtros.');
      return;
    }

    let userId = getSubjectParams({ includeName: false }).user_id;
    if (!userId) {
      await loadUserInspector();
      userId = state.userInspector?.user?.id;
    }
    if (!userId) throw new Error('No he podido resolver el usuario para diagnosticar.');

    const diagnostic = await fetchJson(`/admin/users/${encodeURIComponent(userId)}/diagnostico-digest`, {
      params: { fecha: runParams.fecha },
      admin: true,
    });
    renderDiagnostic(diagnostic);
    showStatus('success', 'Diagnóstico cargado.', `Usuario ${userId} · ${runParams.fecha}`);
  }

  async function loadOverview() {
    if (getAuthMode() !== 'jwt') {
      showStatus('warn', 'Estado MIA requiere JWT.', 'El token de pruebas solo sirve para preview/diagnóstico de digest.');
      return;
    }

    const fecha = elements.fecha.value || todayMadrid();
    const [miaResult, healthResult] = await Promise.allSettled([
      fetchJson('/admin/mia/overview', { admin: true }),
      fetchJson('/admin/operations/health-deep', { params: { fecha }, admin: true }),
    ]);

    renderOverview({
      mia: miaResult.status === 'fulfilled' ? miaResult.value : { ok: false, error: miaResult.reason?.message },
      health: healthResult.status === 'fulfilled' ? healthResult.value : { ok: false, error: healthResult.reason?.message },
    });
    showStatus('success', 'Estado MIA cargado.', 'He leído overview y health-deep.');
  }

  async function copyMessage() {
    const message = state.preview?.mensaje || '';
    if (!message) {
      showStatus('warn', 'No hay mensaje.', 'Genera un preview antes de copiar.');
      return;
    }

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(message);
    } else {
      const textarea = createElement('textarea');
      textarea.value = message;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    showStatus('success', 'Mensaje copiado.', 'Pegado listo para revisar, no para enviar a ciegas 🙂');
  }

  function downloadJson() {
    const content = elements.rawJson.textContent || '{}';
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = createElement('a');
    anchor.href = url;
    anchor.download = `ruralicos-digest-lab-${elements.fecha.value || todayMadrid()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showStatus('success', 'JSON descargado.', 'Incluye preview, diagnóstico, usuario y estado MIA cargado.');
  }

  function clearResults() {
    state.preview = null;
    state.diagnostic = null;
    state.userInspector = null;
    state.overview = null;
    state.lastEnvelope = null;
    renderMetrics();
    renderMessage();
    clearNode(elements.alertsContainer, 'No hay alertas finales en este preview.');
    clearNode(elements.diagnosticContainer, 'Aún no has lanzado el diagnóstico.');
    clearNode(elements.userInspector, 'Busca un usuario con JWT admin para ver su perfil MIA completo.');
    clearNode(elements.overviewBox, 'Pulsa “Cargar estado MIA” con JWT admin para ver salud operativa.');
    renderSuggestions([]);
    updateRawJson();
    showStatus('', 'Resultados vaciados.', 'Puedes lanzar otra prueba limpia.');
  }

  function clearUserFields() {
    elements.userId.value = '';
    elements.phone.value = '';
    elements.nameQuery.value = '';
    renderSuggestions([]);
    state.userInspector = null;
    renderUserInspector(null);
  }

  function updateAuthHint() {
    if (getAuthMode() === 'jwt') {
      elements.tokenHelp.textContent = 'JWT admin: permite buscar usuarios, inspeccionar MIA y usar endpoints /admin.';
      return;
    }
    elements.tokenHelp.textContent = 'Token de pruebas: ideal para preview seguro por ID o teléfono, sin panel admin completo.';
  }

  function bindEvents() {
    document.querySelectorAll('input[name="authMode"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        updateAuthHint();
        saveSessionIfNeeded();
      });
    });

    [elements.apiBase, elements.secret, elements.rememberSecret].forEach((input) => {
      input.addEventListener('change', saveSessionIfNeeded);
    });

    elements.btnSearch.addEventListener('click', () => withBusy(loadUserInspector).catch(showError));
    elements.btnPreview.addEventListener('click', () => withBusy(runPreview).catch(showError));
    elements.btnDiagnose.addEventListener('click', () => withBusy(runDiagnostic).catch(showError));
    elements.btnOverview.addEventListener('click', () => withBusy(loadOverview).catch(showError));
    elements.btnCopy.addEventListener('click', () => withBusy(copyMessage).catch(showError));
    elements.btnDownload.addEventListener('click', downloadJson);
    elements.btnClear.addEventListener('click', clearResults);
    elements.btnClearUser.addEventListener('click', clearUserFields);
  }

  function showError(error) {
    if (handleKnownError(error)) return;
    showStatus('error', 'Ha fallado la prueba.', error?.message || 'Error desconocido');
    updateRawJson();
  }

  function collectElements() {
    [
      'apiBase',
      'secret',
      'rememberSecret',
      'tokenHelp',
      'userId',
      'phone',
      'nameQuery',
      'fecha',
      'useRescate',
      'useIa',
      'btnSearch',
      'btnClearUser',
      'btnPreview',
      'btnDiagnose',
      'btnOverview',
      'btnCopy',
      'btnDownload',
      'btnClear',
      'suggestions',
      'statusBanner',
      'metricGrid',
      'messagePreview',
      'messageMeta',
      'alertsContainer',
      'diagnosticContainer',
      'userInspector',
      'overviewBox',
      'rawJson',
    ].forEach((id) => {
      elements[id] = query(`#${id}`);
    });
  }

  function init() {
    collectElements();
    elements.apiBase.value = cleanBaseUrl(window.location.origin || 'https://ruralicos-api.onrender.com');
    elements.fecha.value = todayMadrid();
    restoreSession();
    updateAuthHint();
    bindEvents();
    clearResults();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
