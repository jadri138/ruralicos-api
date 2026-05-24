const axios = require('axios');
const cheerio = require('cheerio');
const zlib = require('zlib');

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
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
    },
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

function extraerTextosZip(buffer) {
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

async function descargarTextosBeneficiarios(urlDescarga) {
  const { data, headers } = await axios.get(urlDescarga, {
    responseType: 'arraybuffer',
    timeout: Number(process.env.FEGA_DOWNLOAD_TIMEOUT_MS || 120000),
    maxContentLength: Number(process.env.FEGA_MAX_DOWNLOAD_BYTES || 250 * 1024 * 1024),
    headers: {
      Accept: 'application/zip,application/octet-stream,*/*',
      'User-Agent': 'Mozilla/5.0 (RuralicosBot/2.0)',
      Referer: DESCARGA_URL,
    },
  });

  const buffer = Buffer.from(data);
  const contentType = String(headers['content-type'] || '');

  if (buffer.slice(0, 4).toString('latin1') === 'PK\u0003\u0004') {
    return extraerTextosZip(buffer);
  }

  const text = buffer.toString('latin1');
  if (/text|csv|octet-stream/i.test(contentType) && !/<!doctype html|<html[\s>]/i.test(text.slice(0, 1000))) {
    return [{ fileName: 'fega-beneficiarios.txt', text }];
  }

  throw new Error(`Formato de descarga FEGA no soportado: ${contentType || 'desconocido'}`);
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

module.exports = {
  BENEFICIARIOS_URL,
  DESCARGA_URL,
  normalizar,
  obtenerFicheroBeneficiarios,
  descargarTextosBeneficiarios,
  buscarCoincidenciasEnTextos,
};
