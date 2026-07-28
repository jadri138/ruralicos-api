# Automatización de GitHub

- `workflows/ci.yml`: comprobaciones automáticas del backend.
- `dependabot.yml`: propuestas de actualización de dependencias.

Los comandos de CI deben corresponder con `package.json` y funcionar con la versión Node indicada en `engines`. Si se añade una comprobación obligatoria, documentarla también en el README raíz y en `CONTRIBUTING.md`.

No incluir secretos directamente en YAML; usar secretos/variables del repositorio con el alcance mínimo.
