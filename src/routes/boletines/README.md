# Rutas De Boletines

Las rutas históricas de boletines autonómicos se mantienen en `src/routes` para
evitar una migración grande.

Las rutas nuevas de boletines provinciales van aquí:

```text
src/routes/boletines/provinciales/<comunidad>/<codigo_boletin>.js
```

Cada archivo debe exportar una función `(app, supabase) => void`, igual que las
rutas existentes.

