# Código compartido

Utilidades y reglas pequeñas usadas por varios dominios. Deben ser predecibles, fáciles de probar y no depender de Express.

## Grupos

| Tema | Archivos |
| --- | --- |
| Geografía y alcance | `geography.js`, `alertScopeRules.js` |
| Preferencias | `preferenceCanonical.js`, `preferenciasRequest.js`, `sanitizarPreferencias.js` |
| Taxonomía | `sectorTaxonomy.js`, `taxonomyRegistry.js` |
| Texto y documentos | `htmlParser.js`, `pdfExtractor.js`, `similitud.js` |
| Fechas y aprendizaje | `fechaMadrid.js`, `decay.js` |
| Identidad y privacidad | `phoneNormalizer.js`, `passwordPolicy.js`, `pii.js` |
| HTTP y proveedores | `internalBaseUrl.js`, `ultramsgParser.js`, `responderError.js` |

## Reglas destacadas

- La geografía se normaliza antes de comparar; una coincidencia de texto no basta para ampliar alcance.
- Las preferencias se convierten a una forma canónica para que registro, perfil y selección interpreten lo mismo.
- Taxonomía y alias se consultan desde el registro común; no duplicar listas en rutas.
- PII y teléfonos deben enmascararse antes de logs o auditoría.
- Las funciones puras deben devolver datos o errores, no responder directamente a Express.

## Añadir una utilidad

1. Comprobar que realmente la usan varios módulos.
2. Darle una interfaz pequeña y sin efectos ocultos.
3. Añadir pruebas focalizadas.
4. Documentar reglas que cambien selección, seguridad o compatibilidad.

Un archivo “cajón de sastre” no es aceptable: si la función representa un caso de uso, pertenece a un servicio o módulo.
