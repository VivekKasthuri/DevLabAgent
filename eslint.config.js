import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly',
        TextDecoder: 'readonly', TextEncoder: 'readonly', crypto: 'readonly',
        __dirname: 'readonly', require: 'readonly', module: 'readonly',
      },
    },
    rules: {
      // Lenient base — a CLI tool legitimately uses console and dynamic requires
      'no-console': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-useless-escape': 'warn',
      'no-undef': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['ui/public/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly', document: 'readonly', localStorage: 'readonly', navigator: 'readonly',
        WebSocket: 'readonly', location: 'readonly', alert: 'readonly', confirm: 'readonly',
        MediaRecorder: 'readonly', FileReader: 'readonly', Blob: 'readonly', FormData: 'readonly',
      },
    },
  },
  {
    ignores: ['node_modules/**', 'apps/**', 'electron/dist/**', 'dist/**', '.devlab/**', 'examples/**'],
  },
];
