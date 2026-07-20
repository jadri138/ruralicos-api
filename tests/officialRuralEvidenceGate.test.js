const assert = require('assert');

const {
  CAMPOS_GENERADOS_IGNORADOS,
  construirPersistenciaBarreraRural,
  evaluarBarreraRuralOficial,
} = require('../src/modules/alertas/clasificacion/officialRuralEvidenceGate');

function evaluar(titulo, contenido, fuente = 'DOE', extra = {}) {
  return evaluarBarreraRuralOficial({
    titulo,
    contenido,
    fuente,
    region: fuente === 'DOGC' ? 'Cataluna' : 'Extremadura',
    url: 'https://diario-oficial.example/documento',
    ...extra,
  });
}

const negativos = [
  {
    nombre: 'aviso legal y proteccion de datos del DOE',
    fuente: 'DOE',
    titulo: 'Aviso legal y protección de datos',
    contenido: 'Información relativa al tratamiento de datos personales, política de privacidad y delegado de protección de datos del Diario Oficial de Extremadura.',
    code: 'aviso_legal_privacidad_no_rural',
  },
  {
    nombre: 'premio musical',
    fuente: 'DOGC',
    titulo: 'Resolución por la que se convoca el Premio de Música Joven',
    contenido: 'Se abre la convocatoria del premio musical para reconocer obras de composición e interpretación musical presentadas durante este año.',
    code: 'actividad_cultural_no_rural',
  },
  {
    nombre: 'apertura de centro educativo privado',
    fuente: 'DOGC',
    titulo: 'Autorización de apertura de un centro educativo privado',
    contenido: 'Resolución por la que se autoriza la apertura del centro docente de titularidad privada Nova Escola para impartir enseñanzas regladas.',
    code: 'centro_educativo_privado_no_rural',
  },
  {
    nombre: 'instalacion individual de gas',
    fuente: 'DOGC',
    titulo: 'Autorización administrativa de instalaciones de gas',
    contenido: 'Se somete a información pública el expediente de autorización administrativa para una instalación de gas promovida por Energia Local, S.L.',
    code: 'instalacion_gas_individual_no_rural',
  },
  {
    nombre: 'urbanismo industrial o terciario',
    fuente: 'DOE',
    titulo: 'Aprobación de modificación puntual del planeamiento urbanístico',
    contenido: 'La modificación puntual reclasifica el sector para uso industrial y terciario y desarrolla un nuevo polígono industrial sin afecciones agrarias descritas.',
    code: 'urbanismo_no_agrario',
  },
  {
    nombre: 'autorizacion ambiental individual de fertilizantes',
    fuente: 'DOE',
    titulo: 'Autorización ambiental integrada para Fertilizantes del Oeste, S.L.',
    contenido: 'Resolución sobre la autorización ambiental integrada de una planta de fabricación de fertilizantes para uso agrícola promovida por Fertilizantes del Oeste, S.L.',
    code: 'autorizacion_ambiental_individual_no_agraria',
  },
];

for (const caso of negativos) {
  const decision = evaluar(caso.titulo, caso.contenido, caso.fuente);
  assert.strictEqual(decision.action, 'discard', caso.nombre);
  assert.strictEqual(decision.reason_code, caso.code, caso.nombre);

  const persistencia = construirPersistenciaBarreraRural({
    id: caso.nombre,
    fuente: caso.fuente,
    titulo: caso.titulo,
    contenido: caso.contenido,
  }, decision);
  assert.strictEqual(persistencia.action, 'discard', caso.nombre);
  assert.strictEqual(persistencia.patch.estado_ia, 'descartado', caso.nombre);
  assert.strictEqual(persistencia.patch.discard_stage, 'official_rural_gate', caso.nombre);
  assert.strictEqual(
    persistencia.patch.decision_audit.official_rural_gate.reason_code,
    caso.code,
    caso.nombre
  );
}

const ayudaAgraria = evaluar(
  'Convocatoria de ayudas para modernizar explotaciones agrarias',
  'Orden por la que se convocan subvenciones de la PAC destinadas a personas agricultoras y explotaciones agrarias de Extremadura.'
);
assert.strictEqual(ayudaAgraria.action, 'allow');
assert.ok(ayudaAgraria.diagnostics.rural_signals.includes('agricultura'));

const normaGanadera = evaluar(
  'Decreto de sanidad animal en explotaciones ganaderas',
  'La norma regula las medidas zoosanitarias y las obligaciones aplicables al conjunto de explotaciones ganaderas de Cataluña.',
  'DOGC'
);
assert.strictEqual(normaGanadera.action, 'allow');

const convocatoriaRegadio = evaluar(
  'Ajuts per a comunitats de regants',
  'Ordre per la qual es convoquen ajuts per modernitzar els regadius i les infraestructures de les comunitats de regants.',
  'DOGC'
);
assert.strictEqual(convocatoriaRegadio.action, 'allow');

const metadataRuralOficial = evaluar(
  'Resolución de convocatoria',
  'Se establecen los requisitos, personas beneficiarias y plazos de presentación previstos en la resolución oficial.',
  'DOE',
  { metadata_oficial: { organismo: 'Consejería de Agricultura y Ganadería' } }
);
assert.strictEqual(metadataRuralOficial.action, 'allow');
assert.ok(metadataRuralOficial.diagnostics.official_fields_used.includes('organismo'));

const impactoAgrarioExpreso = evaluar(
  'Información pública de una conducción de gas',
  'Autorización administrativa del proyecto de instalación de gas. El trazado afecta a explotaciones agrarias y a una comunidad de regantes, que figuran como interesadas.',
  'DOE'
);
assert.strictEqual(impactoAgrarioExpreso.action, 'allow');

const neutral = evaluar(
  'Resolución de información pública',
  'Se publica la resolución completa del expediente y se abre un periodo de alegaciones para las personas interesadas conforme a la legislación aplicable.'
);
assert.strictEqual(neutral.action, 'review');
assert.strictEqual(
  construirPersistenciaBarreraRural({ fuente: 'DOE' }, neutral).patch.estado_ia,
  'pendiente_revision_manual'
);

const sinContenido = evaluar('Resolución sin texto disponible', 'Resolución sin texto disponible');
assert.strictEqual(sinContenido.action, 'needs_evidence');
assert.strictEqual(
  construirPersistenciaBarreraRural({ fuente: 'DOE' }, sinContenido).patch.estado_ia,
  'needs_evidence'
);

const camposIaNoPruebanRelevancia = evaluar(
  'Resolución de información pública',
  'Se publica el expediente administrativo general y se abre un plazo de audiencia para las personas que acrediten su condición de interesadas.',
  'DOE',
  {
    sectores: ['agricultura'],
    subsectores: ['ganaderia'],
    tipos_alerta: ['ayudas_subvenciones'],
    resumen_borrador: 'Ayuda de la PAC para explotaciones agrarias.',
    resumen_final: 'Convocatoria rural relevante.',
    tags: ['regadio'],
  }
);
assert.strictEqual(camposIaNoPruebanRelevancia.action, 'review');
assert.deepStrictEqual(
  camposIaNoPruebanRelevancia.diagnostics.generated_fields_ignored,
  CAMPOS_GENERADOS_IGNORADOS
);

const procedimientoGanaderoIndividual = evaluar(
  'Autorización ambiental de una explotación ganadera',
  'Autorización ambiental integrada del proyecto de explotación ganadera promovido por Cárnicas del Sur, S.L. en su instalación particular.'
);
assert.strictEqual(procedimientoGanaderoIndividual.action, 'discard');
assert.strictEqual(
  procedimientoGanaderoIndividual.reason_code,
  'procedimiento_empresarial_individual_no_agrario'
);

const fuenteNoControlada = evaluar(
  'Resolución de información pública',
  'Contenido administrativo sin ninguna referencia agraria o rural expresa en el documento oficial.',
  'BOPA'
);
assert.strictEqual(fuenteNoControlada.action, 'allow');
assert.strictEqual(construirPersistenciaBarreraRural({ fuente: 'BOPA' }, fuenteNoControlada), null);

console.log('OK: barrera rural oficial DOGC/DOE');
