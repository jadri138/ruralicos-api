// Detector de texto de ERROR/boilerplate de portal de boletines.
//
// Algunos portales (BOPA Asturias y otros Liferay/sede electronica) devuelven una
// pagina de error con HTTP 200 cuando una disposicion no se puede recuperar, p. ej.:
//   "No se ha podido obtener la disposicion solicitada. Intentelo mas tarde o vuelva
//    a realizar la busqueda".
// Ese texto NO es contenido oficial: si entra como `contenido` de una alerta, la IA
// lo resume como si fuera valido y la alerta llega a estado_ia='listo' siendo basura.
//
// Esta deteccion es de ALTA PRECISION (solo mensajes de error explicitos del portal),
// para usarse en el scraper/pipeline ANTES de marcar la alerta como lista, sin
// relajar el quality gate (alertQuality sigue como ultima barrera, intacto).

function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Mensajes de error explicitos del portal (sin tildes, ya normalizados).
const PORTAL_ERROR_MARKERS = [
  'no se ha podido obtener la disposicion solicitada',
  'no se ha podido obener la disposicion solicitada', // variante con typo observada en portales
  'no se ha podido obtener el documento solicitado',
  'intentelo mas tarde o vuelva a realizar la busqueda',
  'la disposicion solicitada no existe',
  'no se ha encontrado la disposicion solicitada',
];

function esTextoErrorPortal(texto) {
  const t = normalizar(texto);
  if (!t) return false;
  return PORTAL_ERROR_MARKERS.some((marker) => t.includes(marker));
}

module.exports = {
  esTextoErrorPortal,
  PORTAL_ERROR_MARKERS,
};
