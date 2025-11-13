```md
# Ruralicos API 🚜

**Alertas del BOE por WhatsApp para el campo.**

Envía subvenciones, normativas y ayudas del BOE a agricultores por WhatsApp.  
Solo necesitas un móvil.

---

## Estado del proyecto
**MVP 100% funcional**  
- Registro de usuarios  
- Base de datos en Supabase  
- API en producción (Render)  
- Lectura/escritura de alertas  

---

## Endpoints

| Método | Ruta | Descripción |
|-------|------|-------------|
| `GET` | `/` | Estado de la API |
| `POST` | `/register` | Registrar usuario por teléfono |
| `GET` | `/users` | Listar usuarios registrados |
| `POST` | `/alertas` | Guardar alerta del BOE |
| `GET` | `/alertas` | Ver todas las alertas |

---

## Pruebas rápidas (copia-pega)

```bash
# 1. Registrar usuario
curl -X POST https://ruralicos-api.onrender.com/register \
  -H "Content-Type: application/json" \
  -d '{"phone": "+34666123456"}'

# 2. Ver usuarios
curl https://ruralicos-api.onrender.com/users

# 3. Guardar alerta
curl -X POST https://ruralicos-api.onrender.com/alertas \
  -H "Content-Type: application/json" \
  -d '{
    "titulo": "Subvención tractores",
    "resumen": "Hasta 50.000€",
    "url": "https://boe.es/boe/2025/12345",
    "fecha": "2025-11-13",
    "region": "castilla"
  }'
