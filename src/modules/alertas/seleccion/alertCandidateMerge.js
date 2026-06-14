function obtenerIdAlerta(alerta = {}) {
  const id = Number(alerta.id);
  return Number.isFinite(id) ? id : null;
}

function fusionarAlertasUnicas(...listas) {
  const usadas = new Set();
  const resultado = [];

  for (const lista of listas) {
    for (const alerta of Array.isArray(lista) ? lista : []) {
      const id = obtenerIdAlerta(alerta);
      if (!id || usadas.has(id)) continue;
      usadas.add(id);
      resultado.push(alerta);
    }
  }

  return resultado;
}

module.exports = {
  fusionarAlertasUnicas,
  obtenerIdAlerta,
};
