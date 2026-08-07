// Maquina de estados de entrega e intentos atascados.
//
// Incidente 5-08-2026: la tabla de eventos solo tenia PROVIDER_ACCEPTED y
// ninguna entrega confirmada, los reenvios de ACK de UltraMsg dejaban un ERROR
// 23505 en el log de Postgres por cada duplicado, y un intento del 4-08 llevaba
// dias colgado en `evaluating` -esa persona no se volvia a evaluar nunca-.
const assert = require('assert');

const {
  DELIVERY_STATUS,
  deliveryStatusDesdeProveedor,
  esEstadoAceptadoOSuperior,
  puedeIntentarEnvio,
  resolverTransicionEntrega,
} = require('../src/modules/delivery/deliveryState');
const { registrarEventoEntrega } = require('../src/modules/delivery/deliveryService');
const { recuperarIntentosEvaluandoAtascados } = require('../src/modules/mia/digestAttempts');

let aprobados = 0;
function ok(nombre) {
  aprobados++;
  console.log(`OK: ${nombre}`);
}

async function main() {
  // 1. El camino completo avanza en orden y no salta pasos hacia atras.
  {
    const camino = [
      DELIVERY_STATUS.DRAFT,
      DELIVERY_STATUS.APPROVED,
      DELIVERY_STATUS.QUEUED,
      DELIVERY_STATUS.PROVIDER_ACCEPTED,
      DELIVERY_STATUS.DELIVERED,
    ];
    for (let i = 0; i < camino.length - 1; i++) {
      const paso = resolverTransicionEntrega(camino[i], camino[i + 1]);
      assert.strictEqual(paso.apply, true, `${camino[i]} -> ${camino[i + 1]} debe aplicarse`);
      assert.strictEqual(paso.status, camino[i + 1]);
    }
    const atras = resolverTransicionEntrega(DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.PROVIDER_ACCEPTED);
    assert.strictEqual(atras.apply, false, 'un ACK atrasado no degrada una entrega confirmada');
    assert.strictEqual(atras.status, DELIVERY_STATUS.DELIVERED);
    const repetido = resolverTransicionEntrega(DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.DELIVERED);
    assert.strictEqual(repetido.apply, false);
    assert.strictEqual(repetido.reason, 'duplicate');
    ok('DRAFT -> APPROVED -> QUEUED -> PROVIDER_ACCEPTED -> DELIVERED avanza y no retrocede');
  }

  // 2. Aceptado por el proveedor NO es entregado.
  {
    assert.notStrictEqual(DELIVERY_STATUS.PROVIDER_ACCEPTED, DELIVERY_STATUS.DELIVERED);
    assert.strictEqual(deliveryStatusDesdeProveedor('sent'), DELIVERY_STATUS.SENT_TO_WHATSAPP);
    assert.strictEqual(deliveryStatusDesdeProveedor('queued'), DELIVERY_STATUS.PROVIDER_ACCEPTED);
    assert.strictEqual(deliveryStatusDesdeProveedor('delivered'), DELIVERY_STATUS.DELIVERED);
    assert.strictEqual(deliveryStatusDesdeProveedor('read'), DELIVERY_STATUS.READ);
    // Aceptado ya no se puede reenviar (no duplica el mensaje) pero tampoco
    // cuenta como entrega confirmada.
    assert.strictEqual(esEstadoAceptadoOSuperior(DELIVERY_STATUS.PROVIDER_ACCEPTED), true);
    assert.strictEqual(puedeIntentarEnvio(DELIVERY_STATUS.PROVIDER_ACCEPTED), false);
    assert.strictEqual(puedeIntentarEnvio(DELIVERY_STATUS.QUEUED), true);
    assert.strictEqual(
      resolverTransicionEntrega(DELIVERY_STATUS.PROVIDER_ACCEPTED, DELIVERY_STATUS.DELIVERED).apply,
      true,
      'de aceptado a entregado hace falta un ACK del proveedor'
    );
    ok('PROVIDER_ACCEPTED no se confunde con DELIVERED');
  }

  // 3. Un evento duplicado de WhatsApp se ignora sin romper nada.
  {
    const escritos = [];
    let opciones = null;
    const supabase = {
      from() {
        return {
          upsert(row, config) {
            opciones = config;
            const duplicado = escritos.some((item) => item.event_hash === row.event_hash);
            if (!duplicado) escritos.push(row);
            return {
              select() {
                return Promise.resolve({ data: duplicado ? [] : [{ id: escritos.length }], error: null });
              },
            };
          },
        };
      },
    };
    const evento = {
      eventHash: 'hash-ack-1',
      providerMessageId: 'msg-1',
      providerStatus: 'device',
      deliveryStatus: DELIVERY_STATUS.DELIVERED,
      eventAt: '2026-08-05T09:00:00.000Z',
      payloadJson: {},
    };
    const item = { id: 10, user_id: 5, digest_id: 99, provider_message_id: 'msg-1' };

    const primero = await registrarEventoEntrega(supabase, item, evento);
    assert.deepStrictEqual(primero, { inserted: true, duplicate: false });

    const segundo = await registrarEventoEntrega(supabase, item, evento);
    assert.deepStrictEqual(segundo, { inserted: false, duplicate: true }, 'el reenvio se ignora');
    assert.strictEqual(escritos.length, 1, 'no se duplica la fila de auditoria');
    assert.strictEqual(opciones.onConflict, 'event_hash');
    assert.strictEqual(opciones.ignoreDuplicates, true, 'Postgres ignora el duplicado en vez de dar 23505');
    ok('Un evento duplicado de WhatsApp se ignora sin ensuciar la base');
  }

  // 4. Los intentos atascados en `evaluating` vuelven a la cola.
  {
    const filas = [
      { id: 1, user_id: 11, fecha: '2026-08-04', status: 'evaluating', updated_at: '2026-08-04T05:10:00.000Z' },
      { id: 2, user_id: 12, fecha: '2026-08-05', status: 'evaluating', updated_at: '2026-08-05T08:55:00.000Z' },
      { id: 3, user_id: 13, fecha: '2026-08-05', status: 'no_send', updated_at: '2026-08-05T05:00:00.000Z' },
    ];
    const supabase = {
      from() {
        const filtros = [];
        let patch = null;
        const query = {
          update(valores) { patch = valores; return query; },
          eq(columna, valor) { filtros.push(['eq', columna, valor]); return query; },
          lte(columna, valor) { filtros.push(['lte', columna, valor]); return query; },
          lt(columna, valor) { filtros.push(['lt', columna, valor]); return query; },
          select() {
            const afectadas = filas.filter((fila) => filtros.every(([op, columna, valor]) => {
              if (op === 'eq') return fila[columna] === valor;
              if (op === 'lte') return fila[columna] <= valor;
              return fila[columna] < valor;
            }));
            for (const fila of afectadas) Object.assign(fila, patch);
            return Promise.resolve({
              data: afectadas.map(({ id, user_id, fecha }) => ({ id, user_id, fecha })),
              error: null,
            });
          },
        };
        return query;
      },
    };

    const resultado = await recuperarIntentosEvaluandoAtascados(supabase, {
      fecha: '2026-08-05',
      now: new Date('2026-08-05T09:20:00.000Z'),
      staleMs: 30 * 60 * 1000,
    });
    assert.strictEqual(resultado.ok, true);
    assert.strictEqual(resultado.recovered, 1, 'solo el intento realmente atascado se recupera');
    assert.strictEqual(filas[0].status, 'failed', 'el intento del dia anterior se cierra');
    assert.strictEqual(filas[0].motivo_no_envio, 'evaluating_interrumpido_recuperado');
    assert(filas[0].error_msg, 'la causa queda escrita y es legible');
    assert.strictEqual(filas[1].status, 'evaluating', 'un intento en curso reciente no se toca');
    assert.strictEqual(filas[2].status, 'no_send', 'un intento ya cerrado no se toca');
    ok('Un intento colgado en evaluating se cierra con causa y vuelve a la cola');
  }

  // 5. Sin datos suficientes la recuperacion no hace nada silenciosamente.
  {
    const sinFecha = await recuperarIntentosEvaluandoAtascados({ from() { throw new Error('no debe llamarse'); } }, {});
    assert.deepStrictEqual(sinFecha, { ok: false, available: false, recovered: 0 });
    ok('La recuperacion no toca la base si le faltan datos');
  }

  console.log(`\nResultados entrega/recuperacion: ${aprobados} aprobados, 0 fallidos`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
