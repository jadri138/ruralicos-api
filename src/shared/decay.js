/**
 * utils/decay.js
 * 
 * DECAY TEMPORAL
 * 
 * "El feedback viejo es menos importante que el feedback reciente"
 * 
 * Ejemplo:
 *   Hace 10 días: feedback positivo → peso 1.0
 *   Hace 60 días: feedback positivo → peso 0.5
 *   Hace 120 días: feedback positivo → peso 0.25
 * 
 * Así, las preferencias recientes importan más que las antiguas.
 */

/**
 * FUNCIÓN 1: Calcular peso de decay para una fecha
 * 
 * Basado en: ¿Cuántos días han pasado desde entonces?
 * 
 * Fórmula:
 *   0-30 días: peso 1.0 (reciente, máximo peso)
 *   30-60 días: peso 0.5 (menos reciente)
 *   60-90 días: peso 0.25 (viejo)
 *   90+ días: peso 0.1 (muy viejo, casi ignorado)
 * 
 * @param {Date|string|number} fecha - La fecha del feedback
 * @param {Date} fechaActual - Hoy (por defecto, ahora)
 * @returns {number} - Peso entre 0 y 1
 */
function calcularPesoDecay(fecha, fechaActual = new Date()) {
  // Normalizar fecha
  if (typeof fecha === 'string') {
    fecha = new Date(fecha);
  } else if (typeof fecha === 'number') {
    fecha = new Date(fecha);
  }

  if (!(fecha instanceof Date) || isNaN(fecha)) {
    throw new Error('calcularPesoDecay: fecha inválida');
  }

  // Calcular días transcurridos
  const msTranscurridos = fechaActual - fecha;
  const diasTranscurridos = msTranscurridos / (1000 * 60 * 60 * 24);

  // Aplicar decay lineal por "franjas"
  if (diasTranscurridos <= 30) {
    return 1.0; // Reciente: máximo peso
  } else if (diasTranscurridos <= 60) {
    // Entre 30-60 días: interpolar entre 1.0 y 0.5
    return 1.0 - ((diasTranscurridos - 30) / 30) * 0.5;
  } else if (diasTranscurridos <= 90) {
    // Entre 60-90 días: interpolar entre 0.5 y 0.25
    return 0.5 - ((diasTranscurridos - 60) / 30) * 0.25;
  } else {
    // Más de 90 días: peso mínimo
    return 0.1;
  }
}

/**
 * FUNCIÓN 2: Calcular pesos para un array de fechas
 * 
 * Entrada: Array de Date/strings
 * Salida: Array de números (pesos)
 * 
 * @param {(Date|string)[]} fechas - Array de fechas
 * @param {Date} fechaActual
 * @returns {number[]} - Array de pesos correspondientes
 */
function calcularPesosDecay(fechas, fechaActual = new Date()) {
  if (!Array.isArray(fechas)) {
    throw new Error('calcularPesosDecay: necesita array de fechas');
  }

  return fechas.map(fecha => calcularPesoDecay(fecha, fechaActual));
}

/**
 * FUNCIÓN 3: Configurar parámetros de decay
 * 
 * Si quieres cambiar la "curva" de decay, puedes configurarla.
 * Por defecto está bien, pero a veces necesitas "feedback reciente > antiguo mucho".
 * 
 * @param {Object} config
 *   - {number} diasUmbral1 - Días hasta máximo peso (default: 30)
 *   - {number} diasUmbral2 - Días hasta peso medio (default: 60)
 *   - {number} diasUmbral3 - Días hasta peso bajo (default: 90)
 *   - {number} pesoMinimo - Peso mínimo (default: 0.1)
 * 
 * @returns {Object} - Config validada
 */
let CONFIG_DECAY = {
  diasUmbral1: 30,  // Máximo peso (1.0)
  diasUmbral2: 60,  // Peso medio (0.5)
  diasUmbral3: 90,  // Peso bajo (0.25)
  pesoMinimo: 0.1,  // Peso mínimo
};

function configurarDecay(config = {}) {
  if (config.diasUmbral1 !== undefined) CONFIG_DECAY.diasUmbral1 = Number(config.diasUmbral1);
  if (config.diasUmbral2 !== undefined) CONFIG_DECAY.diasUmbral2 = Number(config.diasUmbral2);
  if (config.diasUmbral3 !== undefined) CONFIG_DECAY.diasUmbral3 = Number(config.diasUmbral3);
  if (config.pesoMinimo !== undefined) CONFIG_DECAY.pesoMinimo = Number(config.pesoMinimo);

  // Validaciones
  if (CONFIG_DECAY.diasUmbral1 >= CONFIG_DECAY.diasUmbral2) {
    throw new Error('diasUmbral1 debe ser < diasUmbral2');
  }
  if (CONFIG_DECAY.diasUmbral2 >= CONFIG_DECAY.diasUmbral3) {
    throw new Error('diasUmbral2 debe ser < diasUmbral3');
  }
  if (CONFIG_DECAY.pesoMinimo < 0 || CONFIG_DECAY.pesoMinimo > 1) {
    throw new Error('pesoMinimo debe estar entre 0 y 1');
  }

  return CONFIG_DECAY;
}

/**
 * FUNCIÓN 4: Decay con decay EXPONENCIAL (más agresivo)
 * 
 * En lugar de lineal, puedes usar exponencial.
 * Ejemplo: feedback > 120 días se descarta prácticamente.
 * 
 * @param {Date|string|number} fecha
 * @param {number} tasaDecay - Qué tan agresivo (default: 0.05)
 * @returns {number} - Peso
 */
function calcularPesoDecayExponencial(fecha, tasaDecay = 0.05) {
  if (typeof fecha === 'string') {
    fecha = new Date(fecha);
  } else if (typeof fecha === 'number') {
    fecha = new Date(fecha);
  }

  if (!(fecha instanceof Date) || isNaN(fecha)) {
    throw new Error('calcularPesoDecayExponencial: fecha inválida');
  }

  const msTranscurridos = new Date() - fecha;
  const diasTranscurridos = msTranscurridos / (1000 * 60 * 60 * 24);

  // Decaimiento exponencial: e^(-tasaDecay * días)
  const peso = Math.exp(-tasaDecay * diasTranscurridos);

  return Math.max(0.01, Math.min(1.0, peso)); // Limitar entre 0.01 y 1.0
}

/**
 * FUNCIÓN 5: Aplicar decay a un conjunto de datos
 * 
 * Útil para cuando tienes feedback de múltiples días y quieres ponderar.
 * 
 * Input:
 * [
 *   { valor: 1, fecha: "2026-05-01" },
 *   { valor: -1, fecha: "2026-04-20" },
 *   { valor: 1, fecha: "2026-03-15" }
 * ]
 * 
 * Output: Con .peso añadido
 * [
 *   { valor: 1, fecha: "2026-05-01", peso: 1.0 },
 *   { valor: -1, fecha: "2026-04-20", peso: 0.75 },
 *   { valor: 1, fecha: "2026-03-15", peso: 0.2 }
 * ]
 * 
 * @param {Object[]} items - Array con { valor, fecha, ... }
 * @param {boolean} exponencial - Si usar decay exponencial
 * @returns {Object[]} - Array con .peso añadido
 */
function aplicarDecayAItems(items, exponencial = false) {
  if (!Array.isArray(items)) {
    throw new Error('aplicarDecayAItems: necesita array');
  }

  const ahora = new Date();

  return items.map(item => {
    let peso;
    if (exponencial) {
      peso = calcularPesoDecayExponencial(item.fecha);
    } else {
      peso = calcularPesoDecay(item.fecha, ahora);
    }

    return { ...item, peso };
  });
}

/**
 * FUNCIÓN 6: Información de debugging del decay
 * 
 * Ver visualmente cómo el decay afecta a fechas recientes vs viejas.
 * Útil para validar que la configuración es la que esperas.
 * 
 * @returns {string} - Tabla ASCII con ejemplo
 */
function debugDecay() {
  const ahora = new Date();
  const ejemploFechas = [
    { dias: 0, label: "Hoy" },
    { dias: 15, label: "Hace 15 días" },
    { dias: 30, label: "Hace 30 días" },
    { dias: 45, label: "Hace 45 días" },
    { dias: 60, label: "Hace 60 días" },
    { dias: 90, label: "Hace 90 días" },
    { dias: 120, label: "Hace 120 días" },
  ];

  let output = '\n╔═══════════════════════════════════════════════╗\n';
  output += '║         TABLA DE DECAY TEMPORAL              ║\n';
  output += '╠═══════════════════════════════════════════════╣\n';

  for (const { dias, label } of ejemploFechas) {
    const fecha = new Date(ahora);
    fecha.setDate(fecha.getDate() - dias);

    const peso = calcularPesoDecay(fecha, ahora);
    const barra = '█'.repeat(Math.round(peso * 20)) + '░'.repeat(20 - Math.round(peso * 20));

    output += `║ ${label.padEnd(15)} │ ${barra} │ ${peso.toFixed(2)} ║\n`;
  }

  output += '╚═══════════════════════════════════════════════╝\n';

  return output;
}

module.exports = {
  calcularPesoDecay,
  calcularPesosDecay,
  configurarDecay,
  calcularPesoDecayExponencial,
  aplicarDecayAItems,
  debugDecay,
};
