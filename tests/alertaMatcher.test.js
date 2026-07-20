const assert = require('assert');
const {
  diagnosticarAlertaUsuario,
  inferirSectoresDesdeSubsectores,
  obtenerSectorImplicitoUsuario,
  resolverTerritorioAlerta,
} = require('../src/modules/alertas/seleccion/alertaMatcher');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`OK: ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${name}`);
    console.error(err.message);
  }
}

const userValladolid = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Valladolid'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: { normativa_general: true, ayudas_subvenciones: true },
  },
};

test('provincias [] en alerta equivale a nacional/todas las provincias', () => {
  const alerta = {
    fuente: 'BOCYL',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, true);
});

test('BOE con provincias [] equivale a nacional', () => {
  const alerta = {
    fuente: 'BOE',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, true);
});

test('BOE con provincia concreta no pasa a otra provincia por defecto', () => {
  const alerta = {
    fuente: 'BOE',
    provincias: ['Jaen'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
});

test('marcador nacional en provincias pasa aunque haya provincia de usuario concreta', () => {
  const alerta = {
    fuente: 'BOE',
    provincias: ['nacional'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, true);
});

test('marcador todas no se pisa por provincia mencionada en el titulo', () => {
  const alerta = {
    fuente: 'BOE',
    titulo: 'Ayudas para explotaciones agrarias en Asturias',
    provincias: ['todas'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['ayudas_subvenciones'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, true);
});

test('boletin autonomico con provincia distinta no pasa filtro duro', () => {
  const alerta = {
    fuente: 'BOJA',
    provincias: ['Jaen'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userValladolid);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
});

const userHuesca = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Huesca'],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: { normativa_general: true },
  },
};

test('autonomico sin provincias deriva territorio de la fuente y no se trata como nacional', () => {
  const alerta = {
    fuente: 'DOGC',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userHuesca);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
});

test('BOA sin provincias pasa para usuario de Huesca por territorio de fuente', () => {
  const alerta = {
    fuente: 'BOA',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userHuesca);
  assert.strictEqual(result.ok, true);
});

test('BOP provincial sin provincias solo pasa para su provincia', () => {
  const alerta = {
    fuente: 'BOPZ',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userHuesca);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
});

test('alias BOC de Canarias deriva provincias correctas', () => {
  const alerta = {
    fuente: 'BOC',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userHuesca);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
  assert(result.detalle.alerta.includes('las palmas'));
});

test('alias BOC-CANT permite Cantabria como fuente autonomica normalizada', () => {
  const userCantabria = {
    subscription: 'agricultor',
    preferences: {
      provincias: ['Cantabria'],
      sectores: ['ganaderia'],
      subsectores: ['ovino'],
      tipos_alerta: { normativa_general: true },
    },
  };
  const alerta = {
    fuente: 'BOC-CANT',
    provincias: [],
    sectores: ['ganaderia'],
    subsectores: ['ovino'],
    tipos_alerta: ['normativa_general'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userCantabria);
  assert.strictEqual(result.ok, true);
});

const userJose = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Albacete', 'Ciudad Real', 'Cuenca', 'Teruel', 'Valencia'],
    sectores: ['ganaderia', 'agricultura', 'mixto'],
    subsectores: ['agua', 'medio_ambiente', 'vacuno', 'ovino'],
    tipos_alerta: {
      medio_ambiente: true,
      normativa_general: true,
      ayudas_subvenciones: true,
      agua_infraestructuras: true,
    },
  },
};

test('BOE local con provincia en titulo no se trata como nacional', () => {
  const alerta = {
    fuente: 'BOE',
    titulo: 'Concesion de agua para riego en Corullon (Leon)',
    provincias: [],
    sectores: ['mixto'],
    subsectores: ['agua'],
    tipos_alerta: ['agua_infraestructuras'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userJose);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
  assert(result.detalle.alerta.includes('leon'));
});

test('DOGV local de Castellon no pasa a usuario que solo tiene Valencia', () => {
  const alerta = {
    fuente: 'DOGV',
    titulo: 'Concesion de aguas subterraneas en Useras/Useres (les)',
    provincias: [],
    sectores: ['mixto'],
    subsectores: ['agua'],
    tipos_alerta: ['agua_infraestructuras'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userJose);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
  assert(result.detalle.alerta.includes('castellon'));
});

test('provincia fuerte en titulo corrige provincia explicita contradictoria', () => {
  const alerta = {
    fuente: 'DOGV',
    titulo: 'Concesion de aguas subterraneas en Useras/Useres (les)',
    provincias: ['Valencia'],
    sectores: ['mixto'],
    subsectores: ['agua'],
    tipos_alerta: ['agua_infraestructuras'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userJose);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'provincia_no_coincide');
  assert(result.detalle.alerta.includes('castellon'));
});

test('alerta local en provincia declarada sigue pasando', () => {
  const alerta = {
    fuente: 'DOCM',
    titulo: 'Estudio de impacto ambiental en Albacete',
    provincias: [],
    sectores: ['agricultura'],
    subsectores: ['agua', 'medio_ambiente'],
    tipos_alerta: ['medio_ambiente', 'agua_infraestructuras'],
  };

  const result = diagnosticarAlertaUsuario(alerta, userJose);
  assert.strictEqual(result.ok, true);
});

function userTerritorio(provincia) {
  return {
    subscription: 'cooperativa',
    preferences: {
      provincias: [provincia],
      sectores: ['agricultura'],
      subsectores: [],
      tipos_alerta: { normativa_general: true },
    },
  };
}

function alertaTerritorio(overrides = {}) {
  return {
    fuente: 'BOE',
    provincias: [],
    sectores: ['agricultura'],
    subsectores: [],
    tipos_alerta: ['normativa_general'],
    ...overrides,
  };
}

test('DOE con Extremadura expande Caceres y Badajoz sin alcanzar Salamanca', () => {
  const alerta = alertaTerritorio({ fuente: 'DOE', provincias: ['Extremadura'] });

  assert.strictEqual(diagnosticarAlertaUsuario(alerta, userTerritorio('Caceres')).ok, true);
  assert.strictEqual(diagnosticarAlertaUsuario(alerta, userTerritorio('Badajoz')).ok, true);
  const fuera = diagnosticarAlertaUsuario(alerta, userTerritorio('Salamanca'));
  assert.strictEqual(fuera.ok, false);
  assert.strictEqual(fuera.motivo, 'provincia_no_coincide');
  assert.deepStrictEqual(fuera.detalle.provincias_originales_alerta, ['Extremadura']);
  assert.deepStrictEqual(fuera.detalle.provincias_normalizadas_alerta, ['badajoz', 'caceres']);
  assert.strictEqual(fuera.detalle.ambito_detectado, 'autonomico');
  assert.strictEqual(fuera.detalle.origen_territorio, 'comunidad_autonoma');
});

test('DOGC con Catalunya expande sus cuatro provincias y no alcanza Huesca', () => {
  const alerta = alertaTerritorio({ fuente: 'DOGC', provincias: ['Catalunya'] });

  for (const provincia of ['Barcelona', 'Girona', 'Lleida', 'Tarragona']) {
    assert.strictEqual(diagnosticarAlertaUsuario(alerta, userTerritorio(provincia)).ok, true);
  }
  assert.strictEqual(diagnosticarAlertaUsuario(alerta, userTerritorio('Huesca')).ok, false);
});

test('BOA con Aragon expande Huesca, Zaragoza y Teruel sin alcanzar Navarra', () => {
  const alerta = alertaTerritorio({ fuente: 'BOA', provincias: ['Aragon'] });

  for (const provincia of ['Huesca', 'Zaragoza', 'Teruel']) {
    assert.strictEqual(diagnosticarAlertaUsuario(alerta, userTerritorio(provincia)).ok, true);
  }
  assert.strictEqual(diagnosticarAlertaUsuario(alerta, userTerritorio('Navarra')).ok, false);
});

test('provincia concreta en texto restringe una alerta declarada como Catalunya', () => {
  const alerta = alertaTerritorio({
    fuente: 'DOGC',
    provincias: ['Catalunya'],
    titulo: 'Actuacion ambiental en el municipio de Girona',
  });

  assert.strictEqual(diagnosticarAlertaUsuario(alerta, userTerritorio('Girona')).ok, true);
  const barcelona = diagnosticarAlertaUsuario(alerta, userTerritorio('Barcelona'));
  assert.strictEqual(barcelona.ok, false);
  assert.strictEqual(barcelona.detalle.provincia_concreta_detectada_texto, 'girona');
  assert.strictEqual(barcelona.detalle.origen_territorio, 'texto');
});

test('provincia concreta en texto restringe una alerta declarada como Comunitat Valenciana', () => {
  const alerta = alertaTerritorio({
    fuente: 'DOGV',
    provincias: ['Comunitat Valenciana'],
    titulo: 'Actuacion ambiental en el municipio de Castellon',
  });

  assert.strictEqual(diagnosticarAlertaUsuario(alerta, userTerritorio('Castellon')).ok, true);
  assert.strictEqual(diagnosticarAlertaUsuario(alerta, userTerritorio('Valencia')).ok, false);
  assert.deepStrictEqual(resolverTerritorioAlerta(alerta).provincias_normalizadas, ['castellon', 'castello']);
});

test('subsector singular del usuario coincide con plural de la alerta', () => {
  const alerta = {
    fuente: 'BOE',
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['frutales'],
    tipos_alerta: ['ayudas_subvenciones'],
    titulo: 'Ayudas para explotaciones de frutales en Teruel',
  };
  const userFrutal = {
    subscription: 'cooperativa',
    preferences: {
      provincias: ['Teruel'],
      sectores: ['agrícola'],
      subsectores: ['frutal'],
      tipos_alerta: { ayudas: true },
    },
  };

  const result = diagnosticarAlertaUsuario(alerta, userFrutal);
  assert.strictEqual(result.ok, true);
});

test('tipo plazos no bloquea una ayuda si el texto contiene plazo', () => {
  const alerta = {
    fuente: 'BOE',
    provincias: ['nacional'],
    sectores: ['agricultura'],
    subsectores: ['olivar'],
    tipos_alerta: ['ayudas_subvenciones'],
    titulo: 'Convocatoria de ayudas para olivar',
    resumen_final: 'FICHA_IA\nPLAZO: 20 dias habiles\nACCION: presentar solicitud',
  };
  const userPlazos = {
    subscription: 'cooperativa',
    preferences: {
      provincias: ['Teruel'],
      sectores: ['agricultura'],
      subsectores: ['olivar'],
      tipos_alerta: { plazos: true },
    },
  };

  const result = diagnosticarAlertaUsuario(alerta, userPlazos);
  assert.strictEqual(result.ok, true);
});

const userTeruelAgricola = {
  subscription: 'cooperativa',
  preferences: {
    provincias: ['Teruel'],
    sectores: ['agricultura'],
    subsectores: ['cereal'],
    tipos_alerta: { normativa_general: true },
  },
};

const alertaSinTaxonomia = {
  fuente: 'BOE',
  provincias: ['nacional'],
  sectores: [],
  subsectores: [],
  tipos_alerta: [],
  taxonomy_tags: [],
};

test('taxonomia derivada completamente vacia bloquea la alerta', () => {
  const result = diagnosticarAlertaUsuario(alertaSinTaxonomia, userTeruelAgricola);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'alerta_sin_taxonomia');
  assert.deepStrictEqual(result.detalle, {
    sectores: [],
    subsectores: [],
    tipos_alerta: [],
  });
});

test('usuario sin preferencias no convierte una alerta sin taxonomia en valida', () => {
  const result = diagnosticarAlertaUsuario(alertaSinTaxonomia, {
    subscription: 'cooperativa',
    preferences: {
      provincias: [],
      sectores: [],
      subsectores: [],
      tipos_alerta: {},
    },
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'alerta_sin_taxonomia');
});

test('subsector y tipo sin sector derivado bloquean la alerta', () => {
  const result = diagnosticarAlertaUsuario({
    ...alertaSinTaxonomia,
    subsectores: ['ovino'],
    tipos_alerta: ['sanidad_animal'],
  }, userTeruelAgricola);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'alerta_sin_sector_clasificado');
  assert.deepStrictEqual(result.detalle, {
    sectores: [],
    subsectores: ['ovino'],
    tipos_alerta: ['sanidad_animal'],
  });
});

test('sector derivado desde taxonomy_tags participa en el matching', () => {
  const userGanadero = {
    ...userTeruelAgricola,
    preferences: {
      ...userTeruelAgricola.preferences,
      sectores: ['ganaderia'],
      subsectores: [],
    },
  };
  const result = diagnosticarAlertaUsuario({
    ...alertaSinTaxonomia,
    tipos_alerta: ['normativa_general'],
    taxonomy_tags: ['sector:ganaderia'],
  }, userGanadero);

  assert.strictEqual(result.ok, true);
});

test('sector valido permite una alerta general sin subsector', () => {
  const result = diagnosticarAlertaUsuario({
    ...alertaSinTaxonomia,
    sectores: ['agricultura'],
    tipos_alerta: ['normativa_general'],
  }, userTeruelAgricola);

  assert.strictEqual(result.ok, true);
});

test('usuario sin sectores acepta una alerta correctamente clasificada', () => {
  const result = diagnosticarAlertaUsuario({
    ...alertaSinTaxonomia,
    sectores: ['agricultura'],
    tipos_alerta: ['normativa_general'],
  }, {
    ...userTeruelAgricola,
    preferences: {
      ...userTeruelAgricola.preferences,
      sectores: [],
      subsectores: [],
    },
  });

  assert.strictEqual(result.ok, true);
});

test('sector derivado valido pero incompatible conserva sector_no_coincide', () => {
  const result = diagnosticarAlertaUsuario({
    ...alertaSinTaxonomia,
    tipos_alerta: ['normativa_general'],
    taxonomy_tags: ['sector:ganaderia'],
  }, userTeruelAgricola);

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'sector_no_coincide');
});

function userSectorial({ sectores = [], subsectores = [] } = {}) {
  return {
    subscription: 'cooperativa',
    preferences: {
      provincias: [],
      sectores,
      subsectores,
      tipos_alerta: { normativa_general: true },
    },
  };
}

function alertaSectorial({ sectores = [], subsectores = [], taxonomy_tags = [] } = {}) {
  return {
    fuente: 'BOE',
    provincias: ['nacional'],
    sectores,
    subsectores,
    tipos_alerta: ['normativa_general'],
    taxonomy_tags,
  };
}

test('infiere sectores fuertes con valores canonicos y conserva transversales como neutrales', () => {
  assert.deepStrictEqual(inferirSectoresDesdeSubsectores(['ovejas']), ['ganaderia']);
  assert.deepStrictEqual(inferirSectoresDesdeSubsectores(['olivar']), ['agricultura']);
  assert.deepStrictEqual(inferirSectoresDesdeSubsectores(['ovino', 'cereal']), ['agricultura', 'ganaderia']);
  assert.deepStrictEqual(inferirSectoresDesdeSubsectores(['medio_ambiente', 'desconocido']), []);
});

test('ganadero implicito bloquea una alerta exclusivamente agricola general', () => {
  const user = userSectorial({ subsectores: ['ovino'] });
  const result = diagnosticarAlertaUsuario(alertaSectorial({ sectores: ['agricultura'] }), user);

  assert.deepStrictEqual(obtenerSectorImplicitoUsuario(user), {
    sectores_explicitos: [],
    subsectores: ['ovino'],
    sectores_inferidos: ['ganaderia'],
    origen: 'subsectores',
  });
  assert.deepStrictEqual(result, {
    ok: false,
    motivo: 'sector_inferido_no_coincide',
    detalle: {
      usuario_sectores_explicitos: [],
      usuario_subsectores: ['ovino'],
      usuario_sectores_inferidos: ['ganaderia'],
      origen_sector_usuario: 'subsectores',
      alerta_sectores: ['agricultura'],
      alerta_ambito_sectorial: 'agricultura',
    },
  });
});

test('agricultor implicito bloquea una alerta exclusivamente ganadera general', () => {
  const result = diagnosticarAlertaUsuario(
    alertaSectorial({ sectores: ['ganaderia'] }),
    userSectorial({ subsectores: ['cereal'] })
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'sector_inferido_no_coincide');
});

test('sector implicito acepta alertas generales dentro del mismo sector', () => {
  const ganadero = diagnosticarAlertaUsuario(
    alertaSectorial({ sectores: ['ganaderia'] }),
    userSectorial({ subsectores: ['ovino'] })
  );
  const agricultor = diagnosticarAlertaUsuario(
    alertaSectorial({ sectores: ['agricultura'] }),
    userSectorial({ subsectores: ['olivar'] })
  );

  assert.strictEqual(ganadero.ok, true);
  assert.strictEqual(agricultor.ok, true);
});

test('perfil completamente abierto sigue aceptando alertas clasificadas', () => {
  const result = diagnosticarAlertaUsuario(
    alertaSectorial({ sectores: ['agricultura'] }),
    userSectorial()
  );

  assert.strictEqual(result.ok, true);
});

test('subsector transversal o desconocido no crea barrera sectorial', () => {
  for (const subsector of ['medio_ambiente', 'desconocido']) {
    const user = userSectorial({ subsectores: [subsector] });
    assert.strictEqual(
      diagnosticarAlertaUsuario(alertaSectorial({ sectores: ['agricultura'] }), user).ok,
      true
    );
    assert.strictEqual(
      diagnosticarAlertaUsuario(alertaSectorial({ sectores: ['ganaderia'] }), user).ok,
      true
    );
  }
});

test('usuario explicitamente mixto acepta alertas agricolas y ganaderas', () => {
  const user = userSectorial({ sectores: ['mixto'] });
  assert.strictEqual(diagnosticarAlertaUsuario(alertaSectorial({ sectores: ['agricultura'] }), user).ok, true);
  assert.strictEqual(diagnosticarAlertaUsuario(alertaSectorial({ sectores: ['ganaderia'] }), user).ok, true);
});

test('inferencia mixta acepta alertas agricolas y ganaderas', () => {
  const user = userSectorial({ subsectores: ['ovino', 'cereal'] });
  assert.strictEqual(diagnosticarAlertaUsuario(alertaSectorial({ sectores: ['agricultura'] }), user).ok, true);
  assert.strictEqual(diagnosticarAlertaUsuario(alertaSectorial({ sectores: ['ganaderia'] }), user).ok, true);
});

test('alerta mixta no se bloquea para usuarios con sector implicito', () => {
  assert.strictEqual(
    diagnosticarAlertaUsuario(
      alertaSectorial({ sectores: ['mixto'] }),
      userSectorial({ subsectores: ['ovino'] })
    ).ok,
    true
  );
  assert.strictEqual(
    diagnosticarAlertaUsuario(
      alertaSectorial({ sectores: ['mixto'] }),
      userSectorial({ subsectores: ['cereal'] })
    ).ok,
    true
  );
});

test('sector explicito conserva prioridad sobre subsectores contradictorios', () => {
  const result = diagnosticarAlertaUsuario(
    alertaSectorial({ sectores: ['ganaderia'] }),
    userSectorial({ sectores: ['agricultura'], subsectores: ['ovino'] })
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'sector_no_coincide');
});

test('barrera usa el sector derivado desde taxonomy_tags', () => {
  const result = diagnosticarAlertaUsuario(
    alertaSectorial({ taxonomy_tags: ['sector:agricultura'] }),
    userSectorial({ subsectores: ['ovino'] })
  );

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.motivo, 'sector_inferido_no_coincide');
  assert.deepStrictEqual(result.detalle.alerta_sectores, ['agricultura']);
});

console.log(`\nResultados alertaMatcher: ${passed} aprobados, ${failed} fallidos`);
if (failed > 0) process.exit(1);
