// Flat ESLint config for the app-health TypeScript workspace.
// Wave 0 keeps the lint surface small: type-aware TS rules plus prettier
// formatting parity. Package-local configs can extend this later.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      'packages/go/**',
      'openspec/**',
      '.codex/**',
      '.github/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['examples/dropin-log-client/**/*.js', 'apps/web/public/tracker.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        crypto: 'readonly',
        AbortController: 'readonly',
        URL: 'readonly',
        sessionStorage: 'readonly',
        history: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        Blob: 'readonly',
        fetch: 'readonly',
        window: 'readonly',
        location: 'readonly',
      },
    },
  },
);
