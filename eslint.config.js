// eslint.config.js — configuración flat (ESLint 9)
//
// Objetivo: detectar ERRORES reales (sobre todo referencias no definidas), no
// imponer estilo. El formato lo gestiona Prettier. Se desactiva no-unused-vars
// porque varios módulos importan helpers de forma deliberada (p. ej. las
// sub-rutas de admin y digest importan todo su set de helpers compartidos).

const js = require('@eslint/js');

const nodeGlobals = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  fetch: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  structuredClone: 'readonly',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'public/**', '.refactor-tools/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-useless-escape': 'off',
    },
  },
];
