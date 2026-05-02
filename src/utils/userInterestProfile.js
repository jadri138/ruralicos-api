function norm(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function tagsAlerta(alerta = {}) {
  return [
    ...(Array.isArray(alerta.provincias) ? alerta.provincias.map((x) => `provincia:${norm(x)}`) : []),
    ...(Array.isArray(alerta.sectores) ? alerta.sectores.map((x) => `sector:${norm(x)}`) : []),
    ...(Array.isArray(alerta.subsectores) ? alerta.subsectores.map((x) => `subsector:${norm(x)}`) : []),
    ...(Array.isArray(alerta.tipos_alerta) ? alerta.tipos_alerta.map((x) => `tipo:${norm(x)}`) : []),
    alerta.fuente ? `fuente:${norm(alerta.fuente)}` : null,
  ].filter(Boolean);
}

function scoreAlerta(alerta, pesos = {}) {
  return tagsAlerta(alerta).reduce((acc, tag) => acc + Number(pesos[tag] || 0), 0);
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

async function aplicarFeedbackAlPerfil(supabase, { userId, alerta, valor }) {
  const tags = tagsAlerta(alerta);
  if (!userId || tags.length === 0) return { updated: 0 };

  let updated = 0;
  for (const tag of tags) {
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

    const delta = Number(valor) > 0 ? 1 : -1;
    const next = {
      user_id: userId,
      tag,
      score: Number(actual?.score || 0) + delta,
      positivos: Number(actual?.positivos || 0) + (delta > 0 ? 1 : 0),
      negativos: Number(actual?.negativos || 0) + (delta < 0 ? 1 : 0),
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

  return { updated };
}

function ordenarAlertasPorPerfil(alertas, perfil) {
  const pesos = perfil?.pesos || {};
  return [...alertas].sort((a, b) => scoreAlerta(b, pesos) - scoreAlerta(a, pesos));
}

module.exports = {
  aplicarFeedbackAlPerfil,
  leerPerfilIntereses,
  ordenarAlertasPorPerfil,
  scoreAlerta,
  tagsAlerta,
};
