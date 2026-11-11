// `node --check` proves a file parses. It does NOT prove its identifiers resolve,
// which is exactly how "boardRows is not defined" reached a scheduled sweep on
// 2026-11-04 with every gate green: the reference was legal syntax, in the wrong
// scope, and only the collector's untested main() could hit it.
//
// no-undef is therefore the one blocking rule. Everything else stays advisory so
// this file cannot become a style argument.
const node = {
  console: 'readonly',
  process: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  Buffer: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  AbortController: 'readonly',
  crypto: 'readonly',
  structuredClone: 'readonly',
};

// The browser/worker names reachable from the modules we ship to the edge. The
// client script and service worker are emitted as strings, so they are linted by
// test/stress.mjs through new Function() instead, not here.
const web = {
  self: 'readonly',
  caches: 'readonly',
  Response: 'readonly',
  Request: 'readonly',
  Headers: 'readonly',
  FormData: 'readonly',
  atob: 'readonly',
  btoa: 'readonly',
};

export default [
  {
    // `.dry/` and `.sweep/` are local scratch output, not source: linting them let a
    // scratch file fail the gate that protects a Frontier sweep.
    ignores: ['node_modules/**', '.wrangler/**', 'state.json', 'board.html', '.sweep/**', '.dry/**'],
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...node, ...web },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
