const axios = require('axios');
const cheerio = require('cheerio');
const zlib = require('zlib');
const crypto = require('crypto');

const { cabecerasNavegador } = require('../../../../../platform/httpClient');
const cache = require('./fegaCache');

const FEGA_BASE = 'https://www.fega.gob.es';
const BENEFICIARIOS_URL = `${FEGA_BASE}/es/datos-abiertos/consulta-de-beneficiarios-pac`;
const DESCARGA_URL = `${BENEFICIARIOS_URL}/descarga-de-ficheros`;

function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(href) {
  if (!href) return '';
  if (/^https?:\/\//i.test(href)) return href;
  return new URL(href, FEGA_BASE).toString();
}

function ejercicioActualPublicable() {
  const year = new Date().getFullYear();
  return year - 1;
}

async function getHtml(url) {
  const { data } = await axios.get(url, {
    timeout: 30000,
    headers: cabecerasNavegador({ Referer: BENEFICIARIOS_URL }),
  });
  return String(data || '');
}

function extraerFicherosDescarga(html) {
  const $ = cheerio.load(html);
  const ficheros = [];

  $('a[href]').each((_, el) => {
    const texto = $(el).text().replace(/\s+/g, ' ').trim();
    const href = $(el).attr('href') || '';
    const alrededor = $(el).parent().text().replace(/\s+/g, ' ').trim();
    const bolsa = `${texto} ${alrededor}`;
    const ejercicio = Number((bolsa.match(/\b(20\d{2})\b/) || [])[1]);

    if (!/beneficiarios|transparencia|municipio|descargar|datos/i.test(bolsa)) return;
    if (!ejercicio) return;

    ficheros.push({
      ejercicio,
      titulo: texto || `Datos transparencia beneficiarios municipio ejercicio ${ejercicio}`,
      pagina: absoluteUrl(href),
    });
  });

  return ficheros
    .filter((item, index, arr) => arr.findIndex((other) => other.pagina === item.pagina) === index)
    .sort((a, b) => b.ejercicio - a.ejercicio);
}

async function obtenerFicheroBeneficiarios(ejercicio) {
  const html = await getHtml(DESCARGA_URL);
  const ficheros = extraerFicherosDescarga(html);
  const objetivo = ejercicio
    ? ficheros.find((fichero) => Number(fichero.ejercicio) === Number(ejercicio))
    : ficheros[0];

  if (!objetivo) {
    throw new Error(`No se encontro fichero FEGA para ejercicio ${ejercicio || ejercicioActualPublicable()}`);
  }

  const paginaHtml = await getHtml(objetivo.pagina);
  const $ = cheerio.load(paginaHtml);
  let descarga = '';

  $('a[href]').each((_, el) => {
    const texto = $(el).text().replace(/\s+/g, ' ').trim();
    const href = $(el).attr('href') || '';
    if (!descarga && /descargar/i.test(texto)) descarga = absoluteUrl(href);
  });

  return {
    ...objetivo,
    urlDescarga: descarga || objetivo.pagina,
    paginaDetalle: objetivo.pagina,
  };
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function getZipFileName(buffer, start, length, flags) {
  const bytes = buffer.slice(start, start + length);
  return bytes.toString(flags & 0x0800 ? 'utf8' : 'latin1');
}

function getZipEntryData(buffer, localHeaderOffset, compressedSize) {
  if (localHeaderOffset < 0 || localHeaderOffset > buffer.length - 30) return null;
  if (readUInt32LE(buffer, localHeaderOffset) !== 0x04034b50) return null;

  const fileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fileNameLength + extraLength;
  const dataEnd = dataStart + compressedSize;

  if (dataStart < 0 || dataEnd > buffer.length || compressedSize <= 0) return null;
  return buffer.slice(dataStart, dataEnd);
}

function extraerTextosZipCentralDirectory(buffer) {
  const textos = [];
  let offset = 0;

  while (offset < buffer.length - 46) {
    const signature = readUInt32LE(buffer, offset);
    if (signature !== 0x02014b50) {
      offset++;
      continue;
    }

    const flags = buffer.readUInt16LE(offset + 8);
    const compression = buffer.readUInt16LE(offset + 10);
    const compressedSize = readUInt32LE(buffer, offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = readUInt32LE(buffer, offset + 42);
    const nameStart = offset + 46;
    const nextOffset = nameStart + fileNameLength + extraLength + commentLength;
    const fileName = getZipFileName(buffer, nameStart, fileNameLength, flags);

    if (/\.(csv|txt|tsv)$/i.test(fileName)) {
      const compressed = getZipEntryData(buffer, localHeaderOffset, compressedSize);
      let data = null;
      if (compressed && compression === 0) data = compressed;
      if (compressed && compression === 8) data = zlib.inflateRawSync(compressed);
      if (data) textos.push({ fileName, text: data.toString('latin1') });
    }

    offset = nextOffset > offset ? nextOffset : offset + 46;
  }

  return textos;
}

function extraerTextosZip(buffer) {
  const desdeDirectorio = extraerTextosZipCentralDirectory(buffer);
  if (desdeDirectorio.length > 0) return desdeDirectorio;

  const textos = [];
  let offset = 0;

  while (offset < buffer.length - 30) {
    const signature = readUInt32LE(buffer, offset);
    if (signature !== 0x04034b50) {
      offset++;
      continue;
    }

    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = readUInt32LE(buffer, offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const fileName = buffer.slice(nameStart, nameStart + fileNameLength).toString('utf8');

    if (dataEnd > buffer.length || compressedSize <= 0) break;

    const compressed = buffer.slice(dataStart, dataEnd);
    let data = null;
    if (compression === 0) data = compressed;
    if (compression === 8) data = zlib.inflateRawSync(compressed);

    if (data && /\.(csv|txt|tsv)$/i.test(fileName)) {
      textos.push({ fileName, text: data.toString('latin1') });
    }

    offset = dataEnd;
  }

  return textos;
}

async function descargarBuffer(urlDescarga) {
  const { data, headers } = await axios.get(urlDescarga, {
    responseType: 'arraybuffer',
    timeout: Number(process.env.FEGA_DOWNLOAD_TIMEOUT_MS || 120000),
    maxContentLength: Number(process.env.FEGA_MAX_DOWNLOAD_BYTES || 250 * 1024 * 1024),
    headers: cabecerasNavegador({
      Accept: 'application/zip,application/octet-stream,*/*',
      Referer: DESCARGA_URL,
    }),
  });

  return { buffer: Buffer.from(data), contentType: String(headers['content-type'] || '') };
}

function parsearDescarga(buffer, contentType) {
  if (buffer.slice(0, 4).toString('latin1') ==='PK\u0003\u0004') {
    return extraerTextosZip(buffer);
  }

  const text = buffer.toString('latin1');
  if (/text|csv|octet-stream/i.test(contentType) && !/<!doctype html|<html[\s>]/i.test(text.slice(0, 1000))) {
    return [{ fileName: 'fega-beneficiarios.txt', text }];
  }

  throw new Error(`Formato de descarga FEGA no soportado: ${contentType || 'desconocido'}`);
}

async function descargarTextosBeneficiarios(urlDescarga) {
  const { buffer, contentType } = await descargarBuffer(urlDescarga);
  return parsearDescarga(buffer, contentType);
}

// Firma ligera del fichero remoto (sin transferir el cuerpo) para decidir si la
// cache sigue vigente.
async function obtenerFirmaRemota(urlDescarga) {
  const intentos = Math.max(1, Number(process.env.FEGA_HEAD_ATTEMPTS || 2));
  let ultimoError = null;

  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const { headers } = await axios.head(urlDescarga, {
        timeout: Number(process.env.FEGA_HEAD_TIMEOUT_MS || 30000),
        maxRedirects: 5,
        headers: cabecerasNavegador({ Referer: DESCARGA_URL, Connection: 'close' }),
      });
      return cache.normalizarFirma({
        etag: headers.etag,
        lastModified: headers['last-modified'],
        contentLength: headers['content-length'],
        contentType: headers['content-type'],
      });
    } catch (err) {
      ultimoError = err;
      if (intento < intentos) await new Promise((r) => setTimeout(r, 1000 * intento));
    }
  }

  console.warn('[FEGA] No se pudo obtener firma remota (HEAD):', ultimoError?.message);
  return null;
}

// Devuelve los textos del fichero FEGA reutilizando la cache en disco. Solo
// descarga cuando el fichero remoto ha cambiado (o no hay cache valida).
async function obtenerTextosBeneficiariosConCache(fichero, options = {}) {
  const ejercicio = fichero.ejercicio;
  const urlDescarga = fichero.urlDescarga;
  const forzar = Boolean(options.forzar);

  const firmaRemota = options.firma !== undefined
    ? options.firma
    : await obtenerFirmaRemota(urlDescarga);
  const meta = cache.leerMeta(ejercicio);

  if (!forzar && cache.cacheVigente(meta, firmaRemota, ejercicio)) {
    const textos = parsearDescarga(cache.leerDatos(ejercicio), meta.contentType);
    console.log(`[FEGA] Cache vigente para ejercicio ${ejercicio} (firma coincide, sin descarga)`);
    return { textos, actualizado: false, desdeCache: true, firma: firmaRemota || cache.normalizarFirma(meta) };
  }

  // HEAD caido: si tenemos una copia reciente en disco la reutilizamos en vez de
  // re-descargar el fichero completo mientras la fuente esta inestable.
  if (!forzar && !firmaRemota && cache.cacheFresca(meta, ejercicio)) {
    const textos = parsearDescarga(cache.leerDatos(ejercicio), meta.contentType);
    console.log(`[FEGA] Firma remota no disponible; uso cache reciente de ejercicio ${ejercicio}`);
    return { textos, actualizado: false, desdeCache: true, firma: cache.normalizarFirma(meta) };
  }

  const { buffer, contentType } = await descargarBuffer(urlDescarga);
  const textos = parsearDescarga(buffer, contentType);

  // Persistimos en disco con la firma para futuras ejecuciones. Si la firma
  // remota no estaba disponible (HEAD fallo), guardamos al menos lo conocido.
  cache.guardarDatos(ejercicio, buffer);
  cache.guardarMeta(ejercicio, {
    ejercicio,
    urlDescarga,
    etag: firmaRemota?.etag || null,
    lastModified: firmaRemota?.lastModified || null,
    contentLength: firmaRemota?.contentLength || String(buffer.length),
    contentType: firmaRemota?.contentType || contentType || null,
    downloadedAt: new Date().toISOString(),
  });

  console.log(`[FEGA] Descargado y cacheado ejercicio ${ejercicio} (${buffer.length} bytes)`);
  return { textos, actualizado: true, desdeCache: false, firma: firmaRemota };
}

function prepararUsuariosParaBusqueda(users = []) {
  return users
    .map((user) => {
      const nombreLegal = [
        user.first_name,
        user.last_name_1,
        user.last_name_2,
      ].map((value) => String(value || '').trim()).filter(Boolean).join(' ');
      const nombre = String(user.legal_name || nombreLegal || user.name || '').trim();
      const nombreNormalizado = normalizar(nombre);
      const partes = nombreNormalizado.split(' ').filter(Boolean);

      if (!nombre || partes.length < 3 || nombreNormalizado.length < 10) return null;

      return {
        id: user.id,
        phone: user.phone,
        name: nombre,
        nombreNormalizado,
      };
    })
    .filter(Boolean);
}

function buscarCoincidenciasEnTextos(textos, users) {
  const usuarios = prepararUsuariosParaBusqueda(users);
  const coincidencias = [];
  const vistos = new Set();

  for (const archivo of textos) {
    const lineas = archivo.text.split(/\r?\n/);

    for (const linea of lineas) {
      if (!linea || linea.length < 8) continue;
      const lineaNormalizada = normalizar(linea);
      if (!lineaNormalizada) continue;

      for (const user of usuarios) {
        if (!lineaNormalizada.includes(user.nombreNormalizado)) continue;

        const key = `${user.id}:${archivo.fileName}:${lineaNormalizada.slice(0, 240)}`;
        if (vistos.has(key)) continue;
        vistos.add(key);

        coincidencias.push({
          user_id: user.id,
          organization_id: user.organization_id || null,
          phone: user.phone,
          user_name: user.name,
          beneficiario: user.name,
          archivo: archivo.fileName,
          linea: linea.replace(/\s+/g, ' ').trim().slice(0, 2000),
        });
      }
    }
  }

  return coincidencias;
}

// Firma determinista del conjunto de usuarios "buscables". Si no cambia (y el
// fichero tampoco), el resultado del cruce seria identico, asi que podemos
// saltarnos la extraccion + matching diario.
function firmaUsuarios(users = []) {
  const buscables = prepararUsuariosParaBusqueda(users)
    .map((u) => `${u.id}:${u.nombreNormalizado}`)
    .sort();
  return crypto.createHash('sha256').update(buscables.join('|')).digest('hex');
}

module.exports = {
  BENEFICIARIOS_URL,
  DESCARGA_URL,
  normalizar,
  obtenerFicheroBeneficiarios,
  descargarTextosBeneficiarios,
  obtenerTextosBeneficiariosConCache,
  obtenerFirmaRemota,
  firmaUsuarios,
  buscarCoincidenciasEnTextos,
};
