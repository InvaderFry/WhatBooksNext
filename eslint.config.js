import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'web/dist/**',
      'data/**',
      'fixtures/private/**',
      'tools/store-collector/console-scripts/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['server/**/*.ts', 'scripts/**/*.ts', '*.ts', '*.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['tools/store-collector/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Pages load data in an effect through an async helper that sets state only after
      // `await`; the rule can't see through the helper and flags every such load.
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
