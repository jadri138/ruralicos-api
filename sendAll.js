// sendAll.js
require("dotenv").config();
const fetch = require("node-fetch");
const { createClient } = require("@supabase/supabase-js");

// 1. Configurar Supabase (usamos la SERVICE ROLE KEY)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2. Configurar UltraMsg
const INSTANCE_ID = process.env.ULTRAMSG_INSTANCE;
const TOKEN = process.env.ULTRAMSG_TOKEN;

// Función para enviar un WhatsApp a un número
async function enviarWhatsApp(phone, message) {
  const url = `https://api.ultramsg.com/${INSTANCE_ID}/messages/chat`;

  const payload = {
    token: TOKEN,
    to: phone,          // ejemplo: 346XXXXXXXX
    body: message,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  console.log("→ Enviado a", phone, data);
}

// Función principal: mandar a todos los usuarios
async function sendBroadcast() {
  console.log("📨 Enviando mensaje a todos los usuarios...");

  // 3. Obtener todos los teléfonos de la tabla users
  const { data: users, error } = await supabase
    .from("users")
    .select("phone")
    .not("phone", "is", null)
    .neq("phone", ""); // por si hay vacíos

  if (error) {
    console.error("❌ Error obteniendo usuarios:", error);
    process.exit(1);
  }

  console.log(`Encontrados ${users.length} usuarios con teléfono.`);

  // 4. Mensaje que quieres enviar
  const mensaje = `¡Hola! Ya puedes entrar en tu panel de Ruralicos y configurar tus alertas personalizadas.
Entra aquí 👉 https://ruralicos.es/mis-alertas/`;

  // 5. Enviar uno por uno
  for (const user of users) {
    if (!user.phone) continue;
    // Asegurar formato 34 + número
    let phone = String(user.phone).trim();
    phone = phone.replace(/\D/g, "");
    if (phone.length === 9) {
      phone = "34" + phone;
    }
    console.log("Enviando a:", phone);
    try {
      await enviarWhatsApp(phone, mensaje);
    } catch (err) {
      console.error("Error enviando a", phone, err);
    }
  }

  console.log("✔ Mensaje enviado a todos los contactos.");
  process.exit(0);
}

// Ejecutar
sendBroadcast();
