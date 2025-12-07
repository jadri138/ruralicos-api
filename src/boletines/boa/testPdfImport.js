// src/boletines/testPdfImport.js
const mod = require('pdf-parse');

console.log("Resultado de require('pdf-parse'):");
console.log(mod);

console.log("\nKeys:", Object.keys(mod));

if (typeof mod === 'function') {
  console.log("\n➡️  pdf-parse ES una función directa");
} else if (typeof mod.default === 'function') {
  console.log("\n➡️  La función está en mod.default");
} else {
  console.log("\n❌  Ninguna de las dos formas funciona como función");
}
