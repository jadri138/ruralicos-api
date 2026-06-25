process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test';

const assert = require('assert');
const {
  construirMensajeFallback,
  limpiarContenidoBoletinParaIA,
} = require('../src/modules/alertas/alertas.service');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

console.log('\n=== TESTS: limpieza de entrada de la ficha (Fase 1.5) ===\n');

test('quita el bloque de metadatos JSON anexado a la alerta', () => {
  const contenido = [
    'Resolucion por la que se convocan ayudas para explotaciones agrarias.',
    'El plazo de presentacion de solicitudes sera de 20 dias habiles.',
    '',
    '--- metadatos ---',
    '{"organismo":null,"seccion":null,"boletin":"71","idOficial":"2026/1796","urlHtml":"https://x"}',
  ].join('\n');

  const out = limpiarContenidoBoletinParaIA({ contenido }, 4500);
  assert(!out.includes('idOficial'), 'no debe arrastrar el JSON de metadatos');
  assert(!out.includes('"boletin"'), 'no debe arrastrar claves del JSON');
  assert(out.includes('20 dias habiles'), 'conserva el contenido util');
});

test('elimina el chrome/navegacion del portal aunque venga pegado en una linea', () => {
  const contenido = 'INICIO SEDE ELECTRONICA WEB INSTITUCIONAL BOLETIN OFICIAL DE LA PROVINCIA BOP DEL DIA BUSQUEDAS BUSCAR POR NUMERO INSERCION DE ANUNCIOS Y NORMATIVA BOLETINES HISTORICOS Anuncio 2026-1706 Licencia ambiental de explotacion porcina de cebo.';
  const out = limpiarContenidoBoletinParaIA({ contenido }, 4500);
  assert(!/web institucional/i.test(out), 'quita "web institucional"');
  assert(!/buscar por numero/i.test(out), 'quita "buscar por numero"');
  assert(/licencia ambiental de explotacion porcina/i.test(out), 'conserva el contenido real');
});

test('el deadline al final de un documento largo (una sola linea) sobrevive al truncado', () => {
  let filler = '';
  for (let i = 0; i < 200; i++) {
    filler += `Parrafo numero ${i} con consideraciones administrativas variadas y unicas. `;
  }
  const contenido = `Resolucion de convocatoria de ayudas agrarias. ${filler} Importante: el plazo de presentacion de solicitudes sera de 15 dias habiles desde la publicacion.`;

  const out = limpiarContenidoBoletinParaIA({ contenido }, 2000);
  assert(out.length <= 2000, 'respeta el limite');
  assert(out.includes('15 dias habiles'), 'la fecha limite entra por la ventana relevante aunque este al final');
});

test('cuando no hay contenido, cae al titulo', () => {
  const out = limpiarContenidoBoletinParaIA({ titulo: 'Ayudas para regadio en Teruel', contenido: '' }, 400);
  assert(out.includes('Ayudas para regadio'), 'usa el titulo como respaldo');
});

test('un contenido normal y corto se devuelve intacto (sin romper compatibilidad)', () => {
  const contenido = 'Se aprueba la convocatoria de ayudas para la modernizacion de explotaciones. Plazo hasta el 30 de julio de 2026.';
  const out = limpiarContenidoBoletinParaIA({ contenido }, 4500);
  assert(out.includes('convocatoria de ayudas'));
  assert(out.includes('30 de julio'));
});

test('el fallback no fabrica expediente, solicitud ni plazo', () => {
  const ficha = construirMensajeFallback({
    titulo: 'Bases reguladoras de ayudas agrarias',
    contenido: 'Se publican las bases reguladoras de ayudas agrarias.',
    fecha: '2026-06-25',
  });
  const accion = ficha.split('\n').find((linea) => linea.startsWith('ACCION:')) || '';

  assert(!/\bexpediente\b/i.test(accion));
  assert(!/\bsolicitud\b/i.test(accion));
  assert(!/\bplazo publicado\b/i.test(accion));
  assert.strictEqual(accion, 'ACCION: consultar la publicacion oficial');
});

console.log(`\nResultados limpiarContenidoFicha: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
