const { createClient } = require('@supabase/supabase-js');

// URL del proyecto (igual que antes)
const supabaseUrl = process.env.SUPABASE_URL;

// 🔐 Usamos la SERVICE ROLE KEY (solo en servidor, nunca en el front)
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.error("❌ ERROR: Faltan variables SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY");
  throw new Error("Configuración de Supabase incompleta");
}

// Cliente seguro para backend
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

module.exports = { supabase };
