// @ts-check
import eslint from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ]
    },
  },
  // Enforces docs/architecture.md §10: core modules (ledger, payments, auth)
  // may never import from peripheral modules (kyc, fraud, social, billsplit,
  // scheduling), and a module's public surface is only its <name>.service.ts
  // — everything else inside it is private to that module. Element patterns
  // are defined now, ahead of any module existing, so the very first module
  // added under src/modules/ is governed by this from day one.
  {
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        node: {
          extensions: ['.js', '.ts'],
        },
      },
      'boundaries/elements': [
        {
          type: 'core-module',
          pattern: 'src/modules/{ledger,payments,auth}',
        },
        {
          type: 'peripheral-module',
          pattern: 'src/modules/{kyc,fraud,social,billsplit,scheduling}',
        },
        {
          type: 'shared',
          pattern: 'src/shared',
        },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          policies: [
            {
              from: { element: { type: 'core-module' } },
              disallow: { to: { element: { type: 'peripheral-module' } } },
              message:
                'Core modules (ledger, payments, auth) must never import from peripheral modules (kyc, fraud, social, billsplit, scheduling) — see docs/architecture.md §10.',
            },
          ],
        },
      ],
      // Deprecated in eslint-plugin-boundaries v7 in favor of expressing
      // this as a boundaries/dependencies policy with a fileInternalPath
      // selector, but still functional — kept as-is rather than guessing at
      // unverified migration syntax. Revisit when upgrading past v7.
      'boundaries/entry-point': [
        'error',
        {
          default: 'disallow',
          policies: [
            { target: { type: 'core-module' }, allow: '*.service.ts' },
            { target: { type: 'peripheral-module' }, allow: '*.service.ts' },
          ],
          message:
            "Only a module's exported <name>.service.ts is importable from outside that module — see docs/architecture.md §10.",
        },
      ],
    },
  },
);