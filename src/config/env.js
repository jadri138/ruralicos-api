// src/config/env.js
//
// Inventario y validación del entorno. Una variable mal puesta en un deploy
// no debe descubrirse a las 6:00 con el pipeline fallando: el server valida
// al arrancar (fail-fast en producción, aviso en desarrollo).
//
// Este módulo NO sustituye a los process.env repartidos por el código (eso es
// un refactor aparte); es la lista canónica de lo crítico + su validación.

const VARIABLES_CRITICAS = [
  { name: 'SUPABASE_URL', desc: 'URL del proyecto Supabase', check: (v) => /^https?:\/\//.test(v) || 'debe empezar por http(s)://' },
  { name: 'SUPABASE_SERVICE_ROLE_KEY', desc: 'Service role key de Supabase' },
  { name: 'JWT_SECRET', desc: 'Secreto para firmar JWT (admin/user/org)', check: (v) => v.length >= 16 || 'demasiado corto (<16 chars)' },
  { name: 'CRON_TOKEN', desc: 'Token de los endpoints de cron/tareas', check: (v) => v.length >= 12 || 'demasiado corto (<12 chars)' },
  { name: 'OPENAI_API_KEY', desc: 'API key de OpenAI (clasificar/fichas/digest)' },
  { name: 'PUBLIC_BASE_URL', desc: 'URL pública de esta API (self-calls del pipeline y links de tracking)', check: (v) => /^https?:\/\//.test(v) || 'debe empezar por http(s)://' },
];

// Sin estas la API arranca, pero una parte del producto queda muda.
const VARIABLES_RECOMENDADAS = [
  { name: 'ULTRAMSG_INSTANCE_ID', desc: 'WhatsApp (UltraMsg): sin esto NO se envía ningún mensaje' },
  { name: 'ULTRAMSG_TOKEN', desc: 'WhatsApp (UltraMsg): token de la instancia' },
  { name: 'ULTRAMSG_WEBHOOK_TOKEN', desc: 'Verificación del webhook entrante de UltraMsg (feedback/MIA)' },
  { name: 'ADMIN_ALERT_PHONE', desc: 'Teléfono(s) admin para avisos operativos (salud-fuentes, pipeline)', alias: 'ADMIN_ALERT_PHONES' },
];

function valorDe(env, item) {
  const principal = String(env[item.name] || '').trim();
  if (principal) return principal;
  if (item.alias) return String(env[item.alias] || '').trim();
  return '';
}

function validarEntorno(env = process.env) {
  const faltantes = [];
  const invalidas = [];
  const avisos = [];

  for (const item of VARIABLES_CRITICAS) {
    const valor = valorDe(env, item);
    if (!valor) {
      faltantes.push(`${item.name} — ${item.desc}`);
      continue;
    }
    if (typeof item.check === 'function') {
      const resultado = item.check(valor);
      if (resultado !== true) invalidas.push(`${item.name}: ${resultado}`);
    }
  }

  for (const item of VARIABLES_RECOMENDADAS) {
    if (!valorDe(env, item)) {
      avisos.push(`${item.name} — ${item.desc}`);
    }
  }

  return {
    ok: faltantes.length === 0 && invalidas.length === 0,
    faltantes,
    invalidas,
    avisos,
  };
}

// Valida y reporta. En producción con críticas ausentes: termina el proceso
// (mejor un deploy que falla en rojo que una API a medias). En desarrollo,
// solo avisa para no bloquear trabajo local parcial.
function asegurarEntorno(env = process.env, { exitOnError } = {}) {
  const resultado = validarEntorno(env);
  const esProduccion = (env.NODE_ENV || '').toLowerCase() === 'production';
  const debeSalir = exitOnError ?? esProduccion;

  for (const aviso of resultado.avisos) {
    console.warn(`[env] Aviso: falta ${aviso}`);
  }
  for (const invalida of resultado.invalidas) {
    console.error(`[env] Variable inválida: ${invalida}`);
  }
  for (const faltante of resultado.faltantes) {
    console.error(`[env] FALTA variable crítica: ${faltante}`);
  }

  if (!resultado.ok && debeSalir) {
    console.error('[env] Entorno incompleto: la API no arranca. Corrige las variables y redespliega.');
    process.exit(1);
  }

  return resultado;
}

module.exports = {
  validarEntorno,
  asegurarEntorno,
  VARIABLES_CRITICAS,
  VARIABLES_RECOMENDADAS,
};
