# Ruralicos API 🚜

API para enviar alertas del BOE a usuarios rurales por WhatsApp.

## Endpoints

### `GET /`
→ Estado de la API  
```json
{ "message": "¡Ruralicos API viva! 🚜" }
```

POST /register

curl -X POST https://ruralicos-api.onrender.com/register \
  -H "Content-Type: application/json" \
  -d '{"phone": "+34666123456"}'


GET /users

{
  "titulo": "Subvención Castilla",
  "resumen": "50.000€ para tractores",
  "url": "https://boe.es/...",
  "fecha": "2025-11-13",
  "region": "castilla"
}



Variables de entorno (Render)

SUPABASE_URL=https://yojivxkeuwpjucwzmbzp.supabase.co
SUPABASE_ANON_KEY=eyJhbgc1...
