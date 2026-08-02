const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'modules', 'usuarios', 'usuarios.cuenta.routes.js'),
  'utf8'
);

assert(
  source.includes("selectUserRows('user_interest_profile', 'tag, score, positivos, negativos, updated_at'"),
  'La exportación no consulta el id inexistente del perfil de intereses'
);
assert(source.includes('memory_key, scope_type, scope_value, polarity, source, strength, confidence'));
assert(source.includes('legacy_memory_read_only: legacyStructuredMemories'));
assert(source.includes("app.patch('/me/memory/:id'"), 'Permite corregir una memoria de forma auditable');
assert(source.includes('corregirMemoriaAtomica'));
assert(source.includes('borrarMemoriaAtomica'));
assert(source.includes("deleteUserRows('mia_structured_memory', userId)"));

console.log('OK: cuenta exporta, corrige y borra memoria canónica y legacy');
