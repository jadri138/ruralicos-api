const { decidirAlertaParaDigest } = require('../seleccion/alertSelectionEngine');
const { evaluarCalidadAlerta } = require('../../mia/alertQuality');

const DEFAULT_USER = {
  id: 141,
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Huesca', 'Zaragoza'],
    sectores: ['agricultura', 'ganaderia'],
    subsectores: ['agua', 'vacuno', 'ovino', 'cereal'],
    tipos_alerta: {
      ayudas_subvenciones: true,
      cursos_formacion: true,
      agua_infraestructuras: true,
      normativa_general: true,
      medio_ambiente: true,
      sanidad_animal: true,
      plazos: true,
    },
  },
  preferencias_extra: '',
};

function baseAlerta(id, overrides = {}) {
  return {
    id,
    fuente: 'BOA',
    titulo: `Alerta agraria ${id}`,
    url: `https://example.com/boletin/${id}`,
    fecha: '2026-06-20',
    estado_ia: 'listo',
    resumen_final: [
      'FICHA_IA',
      'TIPO: normativa_general',
      'PRIORIDAD: media',
      'RESUMEN_DIGEST: Aviso agrario con objeto, territorio y accion claros.',
      'HECHO: publicacion de interes agrario',
      'ACCION: revisar publicacion oficial',
    ].join('\n'),
    contenido: 'Publicacion oficial con informacion agraria suficiente para evaluar su interes.',
    provincias: ['Huesca'],
    sectores: ['agricultura'],
    subsectores: ['cereal'],
    tipos_alerta: ['normativa_general'],
    embedding_generated_at: '2026-06-20T08:00:00Z',
    similitud: 0.72,
    ...overrides,
  };
}

const GOLDEN_DATASET_VERSION = 'intelligence_golden_v1';

const INTELLIGENCE_GOLDEN_FIXTURES = [
  {
    id: 'ayuda_con_plazo_claro',
    description: 'Ayuda agraria con convocatoria, beneficiarios y plazo claro.',
    expected: {
      future_decision: 'include',
      reasons: ['ayuda_subvencion', 'accion_con_plazo'],
      must_verify: ['plazo', 'beneficiarios', 'url_oficial'],
    },
    alerta: baseAlerta(1001, {
      titulo: 'Convocatoria de ayudas para modernizacion de explotaciones agrarias en Huesca',
      resumen_final: [
        'FICHA_IA',
        'TIPO: ayudas_subvenciones',
        'PRIORIDAD: alta',
        'RESUMEN_DIGEST: Convocatoria de ayudas para modernizacion de explotaciones agrarias con plazo hasta el 30 de julio.',
        'HECHO: convocatoria de ayudas',
        'BENEFICIARIOS: explotaciones agrarias',
        'PLAZO: hasta el 30 de julio de 2026',
        'ACCION: presentar solicitud',
      ].join('\n'),
      contenido: 'Se convocan ayudas para explotaciones agrarias de Huesca. El plazo de solicitud finaliza el 30 de julio de 2026.',
      tipos_alerta: ['ayudas_subvenciones'],
    }),
  },
  {
    id: 'ayuda_sin_plazo_claro',
    description: 'Ayuda agraria sin plazo demostrable; debe ir a revision si el mensaje quisiera mencionar plazo.',
    expected: {
      future_decision: 'review_only',
      reasons: ['plazo_no_verificado'],
      must_not_invent: ['plazo'],
    },
    alerta: baseAlerta(1002, {
      titulo: 'Ayudas para inversiones en explotaciones agrarias',
      resumen_final: [
        'FICHA_IA',
        'TIPO: ayudas_subvenciones',
        'PRIORIDAD: media',
        'RESUMEN_DIGEST: Se publican ayudas para inversiones agrarias, sin plazo claro en la ficha.',
        'HECHO: ayudas para inversiones agrarias',
        'ACCION: revisar convocatoria',
      ].join('\n'),
      contenido: 'Se publican ayudas para inversiones en explotaciones agrarias. El texto disponible no permite confirmar plazo.',
      tipos_alerta: ['ayudas_subvenciones'],
    }),
  },
  {
    id: 'curso_bienestar_animal',
    description: 'Curso o jornada de bienestar animal con destinatario agrario.',
    expected: {
      future_decision: 'include',
      reasons: ['sanidad_bienestar_animal'],
      must_verify: ['sector', 'accion_requerida'],
    },
    alerta: baseAlerta(1003, {
      titulo: 'Curso de bienestar animal para titulares de explotaciones ganaderas',
      resumen_final: [
        'FICHA_IA',
        'TIPO: cursos_formacion',
        'PRIORIDAD: media',
        'RESUMEN_DIGEST: Curso de bienestar animal dirigido a titulares de explotaciones ganaderas.',
        'HECHO: curso de bienestar animal',
        'ACCION: revisar inscripcion',
      ].join('\n'),
      contenido: 'Curso de bienestar animal para titulares de explotaciones ganaderas de vacuno y ovino.',
      sectores: ['ganaderia'],
      subsectores: ['vacuno', 'ovino'],
      tipos_alerta: ['cursos_formacion', 'sanidad_animal'],
    }),
  },
  {
    id: 'pac_sigpac',
    description: 'Aviso PAC/SIGPAC de ambito agrario claro.',
    expected: {
      future_decision: 'include',
      reasons: ['pac_fega_sigpac'],
      must_verify: ['tipo_documento', 'territorio'],
    },
    alerta: baseAlerta(1004, {
      fuente: 'BOE',
      titulo: 'Actualizacion SIGPAC para la campana PAC 2026',
      resumen_final: 'FICHA_IA\nTIPO: normativa_general\nRESUMEN_DIGEST: Actualizacion SIGPAC para la campana PAC 2026.\nHECHO: actualizacion SIGPAC\nACCION: revisar parcelas.',
      contenido: 'Se actualiza informacion del SIGPAC para la campana PAC 2026 en todo el territorio nacional.',
      provincias: ['todas'],
      tipos_alerta: ['normativa_general', 'plazos'],
    }),
  },
  {
    id: 'agua_riego_general',
    description: 'Norma general de agua/riego con posible impacto amplio.',
    expected: {
      future_decision: 'include',
      reasons: ['agua_general'],
      must_verify: ['territorio', 'accion_requerida'],
    },
    alerta: baseAlerta(1005, {
      titulo: 'Medidas generales de ahorro de agua para comunidades de regantes',
      resumen_final: 'FICHA_IA\nTIPO: agua_infraestructuras\nRESUMEN_DIGEST: Medidas generales de ahorro de agua para comunidades de regantes.\nHECHO: medidas generales de agua y riego\nACCION: revisar obligaciones.',
      contenido: 'Se aprueban medidas generales de ahorro de agua para comunidades de regantes y explotaciones de regadio.',
      subsectores: ['agua'],
      tipos_alerta: ['agua_infraestructuras'],
    }),
  },
  {
    id: 'concesion_agua_individual',
    description: 'Concesion de aguas de expediente particular.',
    expected: {
      future_decision: 'review_only',
      reasons: ['expediente_individual'],
      must_not_claim: ['te_afecta', 'obligatorio_para_ti'],
    },
    alerta: baseAlerta(1006, {
      titulo: 'Solicitud de concesion de aguas para riego en parcela concreta',
      resumen_final: 'FICHA_IA\nTIPO: agua_infraestructuras\nRESUMEN_DIGEST: Solicitud de concesion de aguas para una parcela concreta.\nHECHO: expediente individual de concesion de aguas\nPLAZO: alegaciones durante 20 dias\nACCION: revisar solo si coincide el expediente.',
      contenido: 'Solicitud de concesion de aguas para riego en una parcela concreta. Expediente individual sometido a informacion publica.',
      subsectores: ['agua'],
      tipos_alerta: ['agua_infraestructuras'],
    }),
  },
  {
    id: 'sancion_individual',
    description: 'Sancion o notificacion individual.',
    expected: {
      future_decision: 'blocked',
      reasons: ['notificacion_individual'],
      must_not_claim: ['interes_general'],
    },
    alerta: baseAlerta(1007, {
      titulo: 'Notificacion de expediente sancionador a persona interesada',
      resumen_final: 'FICHA_IA\nTIPO: normativa_general\nRESUMEN_DIGEST: Notificacion individual de expediente sancionador.\nHECHO: sancion individual\nACCION: no enviar en digest general.',
      contenido: 'Notificacion a la persona interesada en procedimiento sancionador individual.',
      tipos_alerta: ['normativa_general'],
    }),
  },
  {
    id: 'alerta_generica',
    description: 'Resumen generico sin objeto administrativo suficiente.',
    expected: {
      future_decision: 'blocked',
      reasons: ['resumen_generico'],
      must_not_claim: ['relevante_para_usuario'],
    },
    alerta: baseAlerta(1008, {
      titulo: 'Publicacion oficial relevante para el sector agrario',
      resumen_final: 'FICHA_IA\nRESUMEN_DIGEST: Publicacion oficial relevante. Revisar si afecta.\nHECHO: publicacion oficial relevante\nACCION: revisar documento completo.',
      contenido: 'Publicacion oficial relevante. Revisar si afecta o aplica.',
    }),
  },
  {
    id: 'sin_url',
    description: 'Alerta sin URL oficial.',
    expected: {
      future_decision: 'blocked',
      reasons: ['sin_url'],
      must_verify: ['url_oficial'],
    },
    alerta: baseAlerta(1009, {
      url: '',
      titulo: 'Ayudas agrarias sin enlace oficial',
      resumen_final: 'FICHA_IA\nTIPO: ayudas_subvenciones\nRESUMEN_DIGEST: Ayudas agrarias sin enlace oficial.\nHECHO: ayudas agrarias\nACCION: no enviar sin URL.',
      tipos_alerta: ['ayudas_subvenciones'],
    }),
  },
  {
    id: 'provincia_no_demostrada',
    description: 'Territorio no coincidente con el usuario.',
    expected: {
      future_decision: 'blocked',
      reasons: ['territorio_no_coincide'],
      must_not_claim: ['huesca', 'zaragoza'],
    },
    alerta: baseAlerta(1010, {
      titulo: 'Ayudas para explotaciones agrarias en Teruel',
      contenido: 'Ayudas para explotaciones agrarias ubicadas en Teruel.',
      provincias: ['Teruel'],
      tipos_alerta: ['ayudas_subvenciones'],
    }),
  },
  {
    id: 'sector_no_demostrado',
    description: 'Sector detectado no coincidente con preferencias declaradas.',
    expected: {
      future_decision: 'blocked',
      reasons: ['sector_no_coincide'],
      must_not_claim: ['agricultura', 'ganaderia'],
    },
    alerta: baseAlerta(1011, {
      titulo: 'Ayudas para el sector pesquero',
      contenido: 'Ayudas dirigidas al sector pesquero y acuicultura marina.',
      sectores: ['pesca'],
      subsectores: ['acuicultura'],
      tipos_alerta: ['ayudas_subvenciones'],
    }),
  },
  {
    id: 'licitacion_bajo_valor',
    description: 'Licitacion o contrato de bajo valor operativo para explotaciones.',
    expected: {
      future_decision: 'blocked',
      reasons: ['licitacion_bajo_valor'],
    },
    alerta: baseAlerta(1012, {
      titulo: 'Formalizacion de contrato de servicios administrativos agrarios',
      resumen_final: 'FICHA_IA\nTIPO: normativa_general\nRESUMEN_DIGEST: Formalizacion de contrato administrativo.\nHECHO: licitacion o contrato\nACCION: no enviar en digest general.',
      contenido: 'Formalizacion de contrato de servicios administrativos y adjudicacion del contrato.',
      tipos_alerta: ['normativa_general'],
    }),
  },
  {
    id: 'preferencias_incompletas',
    description: 'Usuario sin preferencias suficientes; debe evitar afirmaciones fuertes.',
    user: {
      ...DEFAULT_USER,
      preferences: {
        provincias: [],
        sectores: [],
        subsectores: [],
        tipos_alerta: {},
      },
    },
    expected: {
      future_decision: 'review_only',
      reasons: ['perfil_incompleto'],
      must_not_claim: ['te_afecta_directamente'],
    },
    alerta: baseAlerta(1013, {
      titulo: 'Informacion publica sobre medidas agroambientales',
      resumen_final: 'FICHA_IA\nTIPO: medio_ambiente\nRESUMEN_DIGEST: Informacion publica sobre medidas agroambientales con plazo de alegaciones.\nHECHO: informacion publica agroambiental\nPLAZO: 20 dias\nACCION: revisar alegaciones.',
      tipos_alerta: ['medio_ambiente'],
    }),
  },
  {
    id: 'exclusion_explicita_usuario',
    description: 'Usuario excluye explicitamente una materia.',
    expected: {
      future_decision: 'blocked',
      reasons: ['preferencias_extra_excluye'],
    },
    options: {
      exclusionPreferencias: (alerta) => (
        /regadio|riego/i.test(`${alerta.titulo || ''} ${alerta.contenido || ''}`)
          ? { motivo: 'preferencias_extra_excluye', termino: 'no quiere riego' }
          : null
      ),
    },
    alerta: baseAlerta(1014, {
      titulo: 'Ayudas para modernizacion de regadio',
      contenido: 'Ayudas para modernizacion de regadio y riego agricola.',
      subsectores: ['agua'],
      tipos_alerta: ['ayudas_subvenciones', 'agua_infraestructuras'],
    }),
  },
];

function normalizarDecisionFutura(decision = {}) {
  if (decision.action === 'include') return 'include';
  if (decision.action === 'review' || decision.action === 'review_only') return 'review_only';
  return 'blocked';
}

function detectarBrechas({ expected, decision, current_future_equivalent: currentFutureEquivalent }) {
  const gaps = [];

  if (expected.future_decision !== currentFutureEquivalent) {
    gaps.push({
      code: 'future_decision_mismatch',
      expected: expected.future_decision,
      current: currentFutureEquivalent,
    });
  }

  if ((decision.action === 'review' || decision.action === 'review_only') && decision.incluir === true) {
    gaps.push({
      code: 'review_currently_sendable',
      detail: 'El motor marca revision pero incluir=true.',
    });
  }

  if (expected.future_decision !== 'include' && decision.incluir === true) {
    gaps.push({
      code: 'non_include_currently_sendable',
      expected: expected.future_decision,
      current_action: decision.action,
    });
  }

  return gaps;
}

function evaluarEscenarioGolden(fixture) {
  const user = fixture.user || DEFAULT_USER;
  const options = fixture.options || {};
  const decision = decidirAlertaParaDigest(fixture.alerta, user, options);
  const calidad = evaluarCalidadAlerta(fixture.alerta);
  const currentFutureEquivalent = normalizarDecisionFutura(decision);
  const gaps = detectarBrechas({
    expected: fixture.expected,
    decision,
    current_future_equivalent: currentFutureEquivalent,
  });

  return {
    id: fixture.id,
    description: fixture.description,
    expected: fixture.expected,
    current: {
      decision: currentFutureEquivalent,
      action: decision.action,
      incluir: Boolean(decision.incluir),
      motivo: decision.motivo,
      riesgo: decision.riesgo,
      score: decision.score,
      quality_score: calidad.score,
      quality_flags: calidad.flags,
      critical: calidad.critical,
      ranking_reasons: decision.diagnostico?.ranking?.reasons?.map((reason) => reason.code) || [],
      blocks: decision.diagnostico?.policy?.blocks?.map((block) => block.code) || [],
    },
    gaps,
    matches_future_expectation: gaps.length === 0,
  };
}

function ejecutarGoldenDataset({ fixtures = INTELLIGENCE_GOLDEN_FIXTURES } = {}) {
  const scenarios = fixtures.map(evaluarEscenarioGolden);
  const gaps = scenarios.flatMap((scenario) =>
    scenario.gaps.map((gap) => ({ fixture_id: scenario.id, ...gap }))
  );

  return {
    version: GOLDEN_DATASET_VERSION,
    scenarios_total: scenarios.length,
    scenarios_matching_future: scenarios.filter((scenario) => scenario.matches_future_expectation).length,
    scenarios_with_gaps: scenarios.filter((scenario) => scenario.gaps.length > 0).length,
    gaps_total: gaps.length,
    gaps,
    scenarios,
  };
}

module.exports = {
  DEFAULT_USER,
  GOLDEN_DATASET_VERSION,
  INTELLIGENCE_GOLDEN_FIXTURES,
  ejecutarGoldenDataset,
  evaluarEscenarioGolden,
};
