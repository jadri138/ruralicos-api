# Servicios transversales

Casos de uso de negocio compartidos por más de un módulo. A diferencia de `shared/`, estos servicios pueden consultar datos, producir efectos o coordinar dominios.

## Archivos

| Archivo | Responsabilidad |
| --- | --- |
| `officialListMatcher.js` | Coteja alertas con listados oficiales y conserva coincidencias explicables |
| `planChangeNotifier.js` | Aplica la comunicación asociada a cambios de plan |
| `retencionDatos.js` | Calcula y, si está habilitado, ejecuta la retención de datos operativos |

## Cuándo añadir algo aquí

Debe ser una operación reutilizada por varios dominios y no tener un dueño más natural. Si solo la usa alertas, digest o usuarios, debe permanecer en ese módulo.

## Reglas

- Efectos externos explícitos y fáciles de simular.
- Operaciones repetibles o protegidas contra duplicados.
- Resultado estructurado con contadores y errores parciales.
- Modo `dry-run` para limpieza o reparación.
- Auditoría para cambios administrativos sensibles.

Consultar `docs/CUMPLIMIENTO.md` antes de modificar retención. Pruebas: `planChangeNotifier.test.js`, `retencionDatos.test.js` y pruebas de cotejo/administración.
