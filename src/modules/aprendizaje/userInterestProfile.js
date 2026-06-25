const { extraerFeaturesAlerta } = require('./alertFeatures');

function norm(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function tagsAlerta(alerta = {}) {
  return [...new Set([
    ...(Array.isArray(alerta.provincias) ? alerta.provincias.map((x) => `provincia:${norm(x)}`) : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores.map((x) => `sector:${norm(x)}`) : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores.map((x) => `subsector:${norm(x)}`) : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta.map((x) => `tipo:${norm(x)}`) : []),
    ...extraerFeaturesAlerta(alerta),
    alerta.fuente ? `fuente:${norm(alerta.fuente)}` : null,
  ].filter(Boolean))];
}

function scoreAlerta(alerta, pesos = {}) {
  return tagsAlerta(alerta).reduce((acc, tag) => acc + Number(pesos[tag] || 0), 0);
}

function esRechazoGlobalFeedback(texto = '') {
  const value = norm(texto);
  if (!value) return false;
  return /^(ninguna|ninguno|nada|no)$/.test(value) ||
    /\bninguna\b/.test(value) && !/\d/.test(value);
}

function textoMencionaTag(tag = '', rawText = '') {
  const value = norm(String(tag).split(':').slice(1).join(':')).replace(/_/g, ' ');
  const feedback = norm(rawText).replace(/_/g, ' ');
  if (!value || !feedback) return false;
  return feedback.includes(value);
}

function esTagPositivoAtribuible(tag = '', rawText = '') {
  const normalizedTag = norm(tag);
  if (/^(tipo|concepto|subsector|tramite|entidad):/.test(normalizedTag)) return true;
  return textoMencionaTag(normalizedTag, rawText);
}

function calcularAjusteFeedbackTag(tag = '', delta = 0, rawText = '') {
  const ajuste = Number(delta || 0);
  if (!ajuste) return 0;

  const normalizedTag = norm(tag);
  if (ajuste > 0) {
    return esTagPositivoAtribuible(normalizedTag, rawText) ? ajuste : 0;
  }

  const rechazoGlobal = esRechazoGlobalFeedback(rawText);

  // Un voto negativo no debe desmontar preferencias base declaradas.
  if (/^(provincia|sector):/.test(normalizedTag)) return 0;

  if (rechazoGlobal) {
    if (/^tramite:/.test(normalizedTag)) return -0.45;
    if (/^entidad:/.test(normalizedTag)) return -0.35;
    if (/^fuente:/.test(normalizedTag)) return -0.25;
    if (/^tipo:/.test(normalizedTag)) return -0.15;
    return 0;
  }

  if (/^tramite:/.test(normalizedTag)) return -0.7;
  if (/^entidad:/.test(normalizedTag)) return -0.5;
  if (/^fuente:/.test(normalizedTag)) return -0.35;
  if (/^(tipo|concepto|subsector):/.test(normalizedTag)) return -0.35;
  return Math.max(ajuste, -0.25);
}

async function leerPerfilIntereses(supabase, userId) {
  const { data, error } = await supabase
    .from('user_interest_profile')
    .select('tag, score, positivos, negativos')
    .eq('user_id', userId)
    .order('score', { ascending: false });

  if (error) {
    console.warn(`[interest_profile] No se pudo leer perfil user ${userId}:`, error.message);
    return { pesos: {}, resumen: '' };
  }

  const pesos = Object.fromEntries((data || []).map((item) => [item.tag, Number(item.score || 0)]));
  const positivos = (data || [])
    .filter((item) => Number(item.score) > 0)
    .slice(0, 8)
    .map((item) => `${item.tag} (+${item.score})`);
  const negativos = (data || [])
    .filter((item) => Number(item.score) < 0)
    .sort((a, b) => Number(a.score) - Number(b.score))
    .slice(0, 8)
    .map((item) => `${item.tag} (${item.score})`);

  const resumen = [
    positivos.length ? `Le han interesado antes: ${positivos.join(', ')}` : '',
    negativos.length ? `Le han parecido poco utiles antes: ${negativos.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  return { pesos, resumen };
}

async function aplicarFeedbackAlPerfil(supabase, { userId, alerta, delta, rawText = '' }) {
  const tags = tagsAlerta(alerta);
  if (!userId || tags.length === 0) return { updated: 0 };

  const ajuste = Number(delta || 0);
  if (!ajuste) return { updated: 0 };

  let updated = 0;
  let skipped = 0;
  for (const tag of tags) {
    const ajusteTag = calcularAjusteFeedbackTag(tag, ajuste, rawText);
    if (!ajusteTag) {
      skipped++;
      continue;
    }

    const { data: actual, error: selectError } = await supabase
      .from('user_interest_profile')
      .select('score, positivos, negativos')
      .eq('user_id', userId)
      .eq('tag', tag)
      .maybeSingle();

    if (selectError) {
      console.warn(`[interest_profile] Error leyendo tag ${tag}:`, selectError.message);
      continue;
    }

    const next = {
      user_id: userId,
      tag,
      score: Number(actual?.score || 0) + ajusteTag,
      positivos: Number(actual?.positivos || 0) + (ajusteTag > 0 ? 1 : 0),
      negativos: Number(actual?.negativos || 0) + (ajusteTag < 0 ? 1 : 0),
      updated_at: new Date().toISOString(),
    };

    const { error: upsertError } = await supabase
      .from('user_interest_profile')
      .upsert(next, { onConflict: 'user_id,tag' });

    if (upsertError) {
      console.warn(`[interest_profile] Error actualizando tag ${tag}:`, upsertError.message);
      continue;
    }
    updated++;
  }

  return { updated, skipped };
}

function ordenarAlertasPorPerfil(alertas, perfil) {
  const pesos = perfil?.pesos || {};
  return [...alertas].sort((a, b) => scoreAlerta(b, pesos) - scoreAlerta(a, pesos));
}

module.exports = {
  aplicarFeedbackAlPerfil,
  calcularAjusteFeedbackTag,
  esTagPositivoAtribuible,
  esRechazoGlobalFeedback,
  leerPerfilIntereses,
  ordenarAlertasPorPerfil,
  scoreAlerta,
  tagsAlerta,
  textoMencionaTag,
};
