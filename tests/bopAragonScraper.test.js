const assert = require('assert');
const { __testing } = require('../src/modules/boletines/scrapers/provinciales/aragon/scraper');

const {
  bopzBases,
  fechaTextoAISO,
  extraerBopzSumario,
  extraerBophEntradas,
  extraerBophListadoUrl,
  extraerBophPdfUrl,
  extraerBophTotalPaginas,
} = __testing;

console.log('\n=== TESTS: BOP Aragón ===\n');

assert.strictEqual(fechaTextoAISO('15/07/2026'), '2026-07-15');
assert.deepStrictEqual(bopzBases({ BOPZ_BASE_URLS: 'https://alternativo.example, https://bop.dpz.es/' }), [
  'https://alternativo.example',
  'https://bop.dpz.es',
  'https://boletin.dpz.es',
]);

const bopz = extraerBopzSumario(`
  <input name="numBop" value="133">
  <input name="fechaPub" value="15/07/2026">
  <div class="row">Ayuntamiento de Zaragoza</div>
  <div class="row"><a class="enlaceEdicto" onclick="abreVentanaDetalleEdicto('ABC-1')">Ayudas rurales</a></div>
`, { baseUrl: 'https://boletin.dpz.es' });
assert.strictEqual(bopz.length, 1);
assert.strictEqual(bopz[0].fecha, '2026-07-15');
assert(bopz[0].url.startsWith('https://boletin.dpz.es/BOPZ/obtenerContenidoEdicto.do'));

const portada = '<a href="/publica/consulta-de-bops/buscador/BOP-133-2026/">BOP de hoy</a>';
assert.strictEqual(
  extraerBophListadoUrl(portada),
  'https://bop.dphuesca.es/publica/consulta-de-bops/buscador/BOP-133-2026/'
);

const listado = `
  <main>BOP núm. 133
    <ul>
      <li class="elementoListado">
        <a class="enlace_elemento" href="/publica/consulta-de-bops/detalle/2026-133-001" title="Convocatoria de ayudas">
          <h3 class="titulo_elemento">Convocatoria de ayudas</h3>
        </a>
        <span class="fecha_elemento">15/07/2026</span>
        <span class="campo_1">AYUNTAMIENTO DE HUESCA</span>
        <span class="campo_2">Subvenciones</span>
        <span class="campo_3">2026/3001</span>
      </li>
    </ul>
    <a href="?reloaded&page=3">3</a>
  </main>`;
const entradas = extraerBophEntradas(listado);
assert.strictEqual(extraerBophTotalPaginas(listado), 3);
assert.strictEqual(entradas.length, 1);
assert.strictEqual(entradas[0].fecha, '2026-07-15');
assert.strictEqual(entradas[0].boletin, '133');
assert.strictEqual(entradas[0].idOficial, '2026/3001');
assert.strictEqual(entradas[0].organismo, 'AYUNTAMIENTO DE HUESCA');

assert.strictEqual(
  extraerBophPdfUrl('<a href="/Documentos-Anuncios-en-PDF/2026/3001.pdf">PDF</a>'),
  'https://bop.dphuesca.es/Documentos-Anuncios-en-PDF/2026/3001.pdf'
);

console.log('OK: portada, paginación, anuncios y PDF del BOPH actual');
