// Cache en disco del fichero FEGA de beneficiarios PAC.
//
// FEGA publica un fichero anual (~35 MB) que solo cambia de forma esporadica.
// Para no descargarlo en cada ejecucion del pipeline, guardamos el fichero en
// disco junto a una "firma" (ETag / Last-Modified / Content-Length) y solo lo
// volvemos a bajar cuando la firma del servidor cambia. La deteccion de cambios
// se hace con una peticion HEAD, que no transfiere el cuerpo.

const fs = require('fs');
const path = require('path');
const os = require('os');

function cacheDir() {
  return process.env.FEGA_CACHE_DIR || path.join(os.tmpdir(), 'ruralicos', 'fega');
}

function rutaDatos(ejercicio) {
  return path.join(cacheDir(), `fega-${ejercicio}.data`);
}

function rutaMeta(ejercicio) {
  return path.join(cacheDir(), `fega-${ejercicio}.meta.json`);
}

function leerMeta(ejercicio) {
  try {
    return JSON.parse(fs.readFileSync(rutaMeta(ejercicio), 'utf8'));
  } catch {
    return null;
  }
}

function guardarMeta(ejercicio, meta) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(rutaMeta(ejercicio), JSON.stringify(meta, null, 2));
}

// Fusiona campos en la meta existente sin perder la firma ya guardada.
function actualizarMeta(ejercicio, patch) {
  const meta = leerMeta(ejercicio) || { ejercicio };
  guardarMeta(ejercicio, { ...meta, ...patch });
}

function guardarDatos(ejercicio, buffer) {
  fs.mkdirSync(cacheDir(), { recursive: true });
  fs.writeFileSync(rutaDatos(ejercicio), buffer);
}

function leerDatos(ejercicio) {
  return fs.readFileSync(rutaDatos(ejercicio));
}

function datosExisten(ejercicio) {
  return fs.existsSync(rutaDatos(ejercicio));
}

function normalizarFirma(firma) {
  if (!firma) return null;
  return {
    etag: firma.etag || null,
    lastModified: firma.lastModified || null,
    contentLength: firma.contentLength != null ? String(firma.contentLength) : null,
    contentType: firma.contentType || null,
  };
}

// La cache es valida si el fichero sigue en disco y la firma remota coincide
// con la guardada. Preferimos ETag; si no hay, comparamos Last-Modified +
// tamano. Sin ninguno de los dos no podemos garantizar que sea igual -> recargar.
function cacheVigente(meta, firmaRemota, ejercicio) {
  if (!meta || !firmaRemota || !datosExisten(ejercicio)) return false;

  if (meta.etag && firmaRemota.etag) return meta.etag === firmaRemota.etag;

  if (meta.lastModified && firmaRemota.lastModified) {
    return meta.lastModified === firmaRemota.lastModified
      && String(meta.contentLength) === String(firmaRemota.contentLength);
  }

  return false;
}

// Fallback cuando no podemos obtener la firma remota (HEAD caido): si el fichero
// sigue en disco y se descargo hace poco, lo damos por valido para no forzar una
// descarga de decenas de MB en cada ejecucion mientras la fuente este inestable.
function cacheFresca(meta, ejercicio) {
  if (!meta || !datosExisten(ejercicio) || !meta.downloadedAt) return false;
  const maxAgeMs = Number(process.env.FEGA_CACHE_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000);
  const edad = Date.now() - new Date(meta.downloadedAt).getTime();
  return Number.isFinite(edad) && edad >= 0 && edad < maxAgeMs;
}

module.exports = {
  cacheDir,
  rutaDatos,
  rutaMeta,
  leerMeta,
  guardarMeta,
  actualizarMeta,
  guardarDatos,
  leerDatos,
  datosExisten,
  normalizarFirma,
  cacheVigente,
  cacheFresca,
};
