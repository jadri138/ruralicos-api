const assert = require('assert');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

const {
  sanitizarTextoPostgres,
  recortarUnicodeSeguro,
  sanitizarValorPostgres,
} = require('../src/shared/postgresText');
const { construirFichaIA } = require('../src/modules/alertas/alertas.service');

function assertUnicodePostgresSeguro(value) {
  const texto = String(value);
  assert(!texto.includes('\u0000'), 'no debe conservar NUL');
  assert(!Array.from(texto).some((char) => {
    const code = char.charCodeAt(0);
    return (code >= 0x01 && code <= 0x08)
      || code === 0x0B
      || code === 0x0C
      || (code >= 0x0E && code <= 0x1F)
      || (code >= 0x7F && code <= 0x9F);
  }), 'no debe conservar controles');

  for (let index = 0; index < texto.length; index++) {
    const code = texto.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = texto.charCodeAt(index + 1);
      assert(next >= 0xDC00 && next <= 0xDFFF, 'todo sustituto alto debe tener pareja');
      index++;
    } else {
      assert(!(code >= 0xDC00 && code <= 0xDFFF), 'no debe haber sustitutos bajos aislados');
    }
  }
}

console.log('\n=== TESTS: textos seguros para PostgreSQL ===\n');

const corrupto = `Árbol\u0000\u0001 válido 😀 alto:\uD800 bajo:\uDC00 fin`;
const limpio = sanitizarTextoPostgres(corrupto);
assertUnicodePostgresSeguro(limpio);
assert(limpio.includes('Árbol'), 'conserva caracteres españoles');
assert(limpio.includes('😀'), 'conserva pares UTF-16 válidos');
assert(limpio.includes('\uFFFD'), 'repara sustitutos aislados');
console.log('OK: elimina controles y repara Unicode sin perder acentos o emojis válidos');

const bordeEmoji = recortarUnicodeSeguro('1234😀', 5);
assert.strictEqual(bordeEmoji, '1234', 'no debe cortar un emoji por la mitad');
assertUnicodePostgresSeguro(bordeEmoji);
console.log('OK: el recorte nunca deja medio carácter Unicode');

const nested = sanitizarValorPostgres({
  title: 'A\u0000B',
  tags: ['bien', '\uD800mal'],
  score: 4,
});
assert.deepStrictEqual(nested, {
  title: 'A B',
  tags: ['bien', '\uFFFDmal'],
  score: 4,
});
console.log('OK: limpia también arrays y objetos destinados a columnas JSON');

const ficha = construirFichaIA(
  {
    hecho: 'Ayuda\u0000 para olivar \uD800',
    objeto: 'Solicitud',
    impacto: 'Subvención',
  },
  {
    titulo: 'Convocatoria agrícola 😀',
    contenido: 'Información oficial',
    provincias: ['Jaén'],
    sectores: ['olivar'],
  }
);
assertUnicodePostgresSeguro(ficha);
assert(ficha.startsWith('FICHA_IA\n'));
console.log('OK: una ficha generada queda lista para persistir en PostgreSQL');

console.log('\nResultados postgresText: 4 aprobados, 0 fallidos');
