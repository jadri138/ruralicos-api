process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const {
  anadirInstruccionFeedback,
  construirAccionRescate,
  construirResumenFacilDigest,
  construirTituloFacilDigest,
  generarMensajeDigestFallback,
  grupoDigestAlerta,
} = require('../src/modules/digest/digest.service');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`FALLO: ${message}`);
    failed += 1;
    return;
  }
  console.log(`OK: ${message}`);
  passed += 1;
}

console.log('\n=== TESTS: digest message tone ===\n');

const alertaAgua = {
  id: 101,
  titulo: 'Informacion publica sobre solicitud de concesion de aguas subterraneas',
  resumen_final: [
    'HECHO: Se abre informacion publica sobre una solicitud de concesion de aguas subterraneas en Bolanos de Calatrava (Ciudad Real).',
    'ACCION: revisar si aparece tu explotacion, expediente o plazo publicado el 2026-06-15.',
  ].join('\n'),
  resumen: 'Consulta y alegaciones por concesion de aguas subterraneas en Bolanos de Calatrava (Ciudad Real).',
  contenido: 'Confederacion Hidrografica. Aprovechamiento de aguas subterraneas en Bolanos de Calatrava (Ciudad Real).',
  tipos_alerta: ['formacion'],
  provincias: ['Ciudad Real'],
  sectores: ['regadio'],
  url: 'https://go.ruralicos.es/a/test',
};

const grupo = grupoDigestAlerta(alertaAgua);
assert(grupo.key === 'agua_riego', 'Prioriza agua y riego aunque haya etiquetas ruidosas de formacion');
assert(grupo.label === 'Agua y riego', 'Agrupa concesiones de agua bajo Agua y riego');

const titulo = construirTituloFacilDigest(alertaAgua);
assert(titulo.includes('Concesion de agua') || titulo.includes('Concesión de agua'), 'Titula la alerta como concesion de agua');
assert(titulo.includes('Bolanos de Calatrava') || titulo.includes('Bolaños de Calatrava'), 'Incluye la localidad para evitar titulos repetidos');

const resumen = construirResumenFacilDigest(alertaAgua, 320);
assert(/concesi[oó]n de aguas/i.test(resumen), 'El resumen explica que es una concesion de aguas');
assert(!/Te afecta si/i.test(resumen), 'Evita formula directa y repetida "Te afecta si"');

const accion = construirAccionRescate(alertaAgua, 'directo');
assert(accion.startsWith('Comprueba si'), 'Convierte acciones crudas en una frase natural');
assert(!/publicado el 2026-06-15/i.test(accion), 'Elimina fecha redundante de la accion');

const mensaje = anadirInstruccionFeedback(
  generarMensajeDigestFallback({
    user: { nombre: 'Jose', subscription: 'agricultor' },
    alertas: [alertaAgua],
    fecha: '2026-06-15',
  }),
  [alertaAgua]
);
assert(mensaje.includes('*Agua y riego*'), 'El mensaje final usa el grupo correcto');
assert(mensaje.includes('Qué revisar: Comprueba'), 'El mensaje final evita "Qué revisar: revisar"');
assert(!mensaje.includes('Qué miraría'), 'El mensaje final no usa el texto antiguo');
assert(mensaje.includes('_Si te interesa, responde con *1*. Si no, responde *ninguna*._'), 'Usa cierre de feedback natural');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
