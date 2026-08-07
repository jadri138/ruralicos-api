// Barrera territorial de la autoridad canonica.
//
// Incidente 5-08-2026: la ficha v3 escribe el centinela "no_detectado" cuando no
// ha sabido extraer el territorio. La ficha de verdad lo consumia como si fuera
// una provincia real, de modo que ninguna alerta estatal coincidia con el
// territorio de nadie: 53 candidatas bloqueadas con TERRITORY_MISMATCH y cero
// digests en todo el dia. Estas pruebas fijan las dos reglas que lo evitan:
//   1) un centinela no es territorio;
//   2) sin territorio declarado manda el boletin que publica la alerta.
const assert = require('assert');

const {
  adaptAlertTruthCard,
  ambitoTerritorialDeFuente,
  esTerritorioSinDato,
} = require('../src/modules/alertas/decision/truthCard');
const {
  evaluateCandidateEligibility,
  territoryEligibility,
} = require('../src/modules/alertas/decision/candidatePipeline');

const AHORA = new Date('2026-08-05T05:00:00.000Z');
let aprobados = 0;

function ok(nombre) {
  aprobados++;
  console.log(`OK: ${nombre}`);
}

function perfil(provincias, { sectores = ['agricultura'], subsectores = [] } = {}) {
  return {
    subject_id: 143,
    operational: {
      territory: { provinces: provincias, regions: [], municipalities: [] },
      activity: { sectors: sectores, subsectors: subsectores, crops: [], species: [] },
    },
    memories: { negative: [] },
    preferences: {},
  };
}

function campoOficial(valor) {
  return {
    valor,
    source: 'raw_document.texto_raw',
    status: 'verified',
    evidencia: valor,
    confidence: 0.9,
    evidence_level: 'official',
  };
}

function fichaV3({ territorio, fuente = 'BOE', alertaId = 21335 }) {
  return {
    entrada: {
      alerta_id: alertaId,
      schema_version: 'fact_sheet_v3',
      status: 'ready_for_digest',
      fact_sheet: {
        schema_version: 'fact_sheet_v3',
        alerta_id: alertaId,
        status: 'ready_for_digest',
        territorio,
        sectores: [campoOficial('agricultura')],
        beneficiarios: campoOficial('Personas fisicas titulares de explotaciones agrarias.'),
        accion_requerida: campoOficial('Presentar la solicitud en el plazo indicado.'),
        url_oficial: campoOficial('https://www.boe.es/boe/dias/2026/08/05/pdfs/ejemplo.pdf'),
        tipo_documento: { valor: 'convocatoria de ayuda' },
        tema_principal: { valor: 'ayudas al sector agrario' },
        resumen_neutro: { valor: 'Convocatoria de ayudas publicada en el boletin oficial.' },
      },
    },
    opciones: { legacyAlert: { id: alertaId, fuente, provincias: [], url: 'https://example.org/x' } },
  };
}

// 1. El centinela de "sin territorio" nunca es un territorio.
for (const centinela of ['no_detectado', 'NO DETECTADO', 'desconocido', 'sin determinar', 'n/a', '']) {
  assert.strictEqual(
    esTerritorioSinDato(centinela),
    true,
    `"${centinela}" debe tratarse como territorio sin dato`
  );
}
assert.strictEqual(esTerritorioSinDato('Cordoba'), false);
assert.strictEqual(esTerritorioSinDato('Andalucia'), false);
ok('Los valores centinela no se confunden con una provincia real');

// 2. Ficha v3 del BOE con territorio "no_detectado": es estatal, no un choque
//    territorial. Este es el caso exacto de la alerta 21335 el 5-08-2026.
{
  const { entrada, opciones } = fichaV3({
    territorio: [{
      valor: 'no_detectado',
      source: 'stored_text:structured',
      status: 'supported',
      evidencia: 'TERRITORIO: no_detectado',
      confidence: 0.72,
      evidence_level: 'supported',
    }],
  });
  const card = adaptAlertTruthCard(entrada, opciones);
  assert.strictEqual(card.territory.national, true, 'una convocatoria del BOE sin territorio es estatal');
  assert.deepStrictEqual(card.territory.provinces, [], 'el centinela no deja provincias fantasma');

  const eleg = evaluateCandidateEligibility(
    { alert_id: 21335, truth_card: card },
    perfil(['Cordoba']),
    { now: AHORA }
  );
  assert.strictEqual(eleg.eligible, true, 'la candidata pasa la barrera territorial');
  assert(
    eleg.reason_codes.includes('TERRITORY_NATIONAL'),
    'el motivo registrado es el ambito estatal'
  );
  ok('Ficha v3 del BOE con territorio no detectado llega a un usuario de Cordoba');
}

// 3. Boletin autonomico sin territorio declarado: alcanza a sus provincias y
//    solo a ellas.
{
  const { entrada, opciones } = fichaV3({ territorio: [], fuente: 'BOA', alertaId: 9001 });
  const card = adaptAlertTruthCard(entrada, opciones);
  assert.strictEqual(card.territory.national, false, 'un boletin autonomico no es estatal');
  assert.deepStrictEqual(
    card.territory.provinces.slice().sort(),
    ['huesca', 'teruel', 'zaragoza'],
    'el BOA cubre las tres provincias de Aragon'
  );
  assert.strictEqual(
    territoryEligibility(card, perfil(['Teruel'])).allowed,
    true,
    'un usuario de Teruel recibe el BOA'
  );
  assert.strictEqual(
    territoryEligibility(card, perfil(['Cordoba'])).allowed,
    false,
    'un usuario de Cordoba no recibe el BOA'
  );
  ok('Un boletin autonomico sin territorio alcanza sus provincias y no cruza territorio');
}

// 4. El territorio declarado siempre manda sobre el boletin: una alerta del BOE
//    con provincia concreta sigue siendo provincial.
{
  const { entrada, opciones } = fichaV3({
    territorio: [{
      valor: 'Huesca',
      source: 'raw_document.texto_raw',
      status: 'verified',
      evidencia: 'provincia de Huesca',
      confidence: 0.9,
      evidence_level: 'official',
    }],
    alertaId: 9002,
  });
  const card = adaptAlertTruthCard(entrada, opciones);
  assert.strictEqual(card.territory.national, false, 'el BOE no convierte en estatal lo que declara provincia');
  assert.deepStrictEqual(card.territory.provinces, ['Huesca']);
  assert.strictEqual(territoryEligibility(card, perfil(['Cordoba'])).allowed, false);
  assert.strictEqual(territoryEligibility(card, perfil(['Huesca'])).allowed, true);
  ok('Una convocatoria del BOE con provincia declarada no se convierte en estatal');
}

// 5. Alerta legacy (sin ficha) del BOE sin provincias: tambien es estatal, y una
//    fuente desconocida sigue sin inventarse territorio.
{
  const legacy = {
    id: 9003,
    fuente: 'BOE',
    provincias: [],
    titulo: 'Extracto de convocatoria de ayudas al sector agrario',
    url: 'https://www.boe.es/ejemplo',
  };
  const card = adaptAlertTruthCard(legacy, { legacyAlert: legacy });
  assert.strictEqual(card.territory.national, true);
  assert.strictEqual(territoryEligibility(card, perfil(['Cordoba'])).allowed, true);

  const desconocida = adaptAlertTruthCard(
    { ...legacy, id: 9004, fuente: 'BOLETIN_INVENTADO' },
    { legacyAlert: { ...legacy, id: 9004, fuente: 'BOLETIN_INVENTADO' } }
  );
  assert.strictEqual(desconocida.territory.national, false, 'una fuente desconocida no da alcance estatal');
  assert.deepStrictEqual(desconocida.territory.provinces, []);
  ok('Alerta legacy del BOE es estatal y una fuente desconocida no inventa alcance');
}

// 6. El mapa de ambito por fuente responde lo que dice el boletin.
{
  assert.deepStrictEqual(ambitoTerritorialDeFuente('BOE'), { source: 'BOE', national: true, provinces: [] });
  assert.deepStrictEqual(ambitoTerritorialDeFuente('FEGA'), { source: 'FEGA', national: true, provinces: [] });
  assert.deepStrictEqual(ambitoTerritorialDeFuente('BON'), { source: 'BON', national: false, provinces: ['navarra'] });
  assert.strictEqual(ambitoTerritorialDeFuente('no_existe'), null);
  assert.strictEqual(ambitoTerritorialDeFuente(''), null);
  ok('El ambito por boletin distingue estatal, autonomico y desconocido');
}

console.log(`\nResultados territorio canonico: ${aprobados} aprobados, 0 fallidos`);
