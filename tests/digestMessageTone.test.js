process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const {
  anadirInstruccionFeedback,
  construirAccionRescate,
  construirResumenFacilDigest,
  construirTituloFacilDigest,
  formatearFechaDigest,
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
assert(!mensaje.includes('En sencillo:'), 'El mensaje final elimina la etiqueta mecanica "En sencillo"');
assert(!mensaje.includes('Qué revisar:'), 'El mensaje final integra la accion en una frase natural');
assert(mensaje.includes('Comprueba si'), 'El mensaje final conserva la accion util sin etiqueta');
assert(!mensaje.includes('Qué miraría'), 'El mensaje final no usa el texto antiguo');
assert(mensaje.includes('_Si te interesa, responde con *1*. Si no, responde *ninguna*._'), 'Usa cierre de feedback natural');
assert(formatearFechaDigest('2026-06-23') === '23 de junio', 'Convierte la fecha ISO a una fecha natural');

const alertaAyudaSinPlazo = {
  id: 102,
  titulo: 'Convocatoria de subvenciones para explotaciones agrarias de titularidad compartida',
  resumen_final: [
    'FICHA_IA',
    'TIPO: ayudas_subvenciones',
    'RESUMEN_DIGEST: Se convocan subvenciones para explotaciones agrarias de titularidad compartida.',
    'PLAZO: no_detectado',
    'ACCION: revisar si aparece tu explotacion, expediente o plazo publicado el 2026-06-23.',
  ].join('\n'),
  tipos_alerta: ['ayudas_subvenciones'],
  sectores: ['agricultura'],
  contenido: 'Beneficiarios: explotaciones agrarias de titularidad compartida inscritas en el Registro de explotaciones agrarias de titularidad compartida del Ministerio.',
  url: 'https://boletin.example/ayuda',
  decision_digest: {
    action: 'include',
    diagnostico: {
      policy: {
        signals: {
          es_ayuda: true,
          tiene_plazo: false,
          plazo_no_verificado: true,
        },
      },
    },
  },
};

const accionAyudaSinPlazo = construirAccionRescate(alertaAyudaSinPlazo, 'directo');
assert(!/\bplazo\b/i.test(accionAyudaSinPlazo), 'No reutiliza el plazo no verificado en la accion del mensaje');
assert(/inscrita en el registro del Ministerio/i.test(accionAyudaSinPlazo), 'Explica de forma natural la condicion demostrada por el texto oficial');

const mensajeAyudaNatural = generarMensajeDigestFallback({
  user: { nombre: 'Maria', subscription: 'cooperativa' },
  alertas: [alertaAyudaSinPlazo],
  fecha: '2026-06-23',
});
assert(mensajeAyudaNatural.includes('*Ruralicos - Alertas del 23 de junio*'), 'La cabecera usa una fecha humana');
assert(mensajeAyudaNatural.includes('*1. Ayuda para explotaciones de titularidad compartida*'), 'Usa un titulo corto centrado en el beneficiario');
assert(mensajeAyudaNatural.includes('Han abierto una subvención para explotaciones agrarias de titularidad compartida.'), 'Explica la convocatoria con una frase natural');
assert(mensajeAyudaNatural.includes('Si la tuya está inscrita en el registro del Ministerio, puedes comprobar los requisitos en la convocatoria.'), 'Integra la accion como segunda frase natural');
assert(!mensajeAyudaNatural.includes('URGENTE -'), 'No exagera urgencia cuando el plazo no esta verificado');
assert(!mensajeAyudaNatural.includes('Tienes *1 alerta* relevante hoy'), 'Elimina la entradilla mecanica del fallback');

console.log(`\nResultados: ${passed} aprobados, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
