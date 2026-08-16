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
  // Enforces docs/architecture.md §10: core modules (ledger, payments, auth,
  // users) may never import from peripheral modules (kyc, fraud, social,
  // billsplit, scheduling), and a module's public surface is only its
  // <name>.service.ts — everything else inside it is private to that
  // module. Element patterns are defined now, ahead of any module existing,
  // so the very first module added under src/modules/ is governed by this
  // from day one.
  //
  // `auth` and `users` are each their own element type, not lumped into one
  // generic `core-module` type like `ledger`/`payments` — ADR-0005's actual
  // invariant is directional (`auth` depends on `users`, never the reverse,
  // specifically to avoid a cycle), and a single shared `core-module` type
  // can't express "these two core modules may not depend on each other in
  // one direction." Policies below repeat per module type instead of using
  // `{ type: { anyOf: [...] } }` to group them — the installed
  // eslint-plugin-boundaries version (7.0.2) throws
  // ("template.replaceAll is not a function") when a dependencies/
  // entry-point selector's `type` uses `anyOf` or a plain array; verified
  // directly by hitting it. Single-string `type` per policy entry avoids
  // the broken code path.
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
          type: 'ledger-module',
          pattern: 'src/modules/ledger/**',
        },
        {
          type: 'payments-module',
          pattern: 'src/modules/payments/**',
        },
        {
          type: 'auth-module',
          pattern: 'src/modules/auth/**',
        },
        {
          type: 'users-module',
          pattern: 'src/modules/users/**',
        },
        {
          type: 'transfers-module',
          pattern: 'src/modules/transfers/**',
        },
        {
          type: 'peripheral-module',
          pattern:
            'src/modules/{kyc,fraud,social,billsplit,scheduling,notifications}',
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
              from: { element: { type: 'ledger-module' } },
              disallow: { to: { element: { type: 'peripheral-module' } } },
              message:
                'Core modules (ledger, payments, auth, users) must never import from peripheral modules (kyc, fraud, social, billsplit, scheduling, notifications) — see docs/architecture.md §10.',
            },
            {
              from: { element: { type: 'payments-module' } },
              disallow: { to: { element: { type: 'peripheral-module' } } },
              message:
                'Core modules (ledger, payments, auth, users) must never import from peripheral modules (kyc, fraud, social, billsplit, scheduling, notifications) — see docs/architecture.md §10.',
            },
            {
              from: { element: { type: 'auth-module' } },
              disallow: { to: { element: { type: 'peripheral-module' } } },
              message:
                'Core modules (ledger, payments, auth, users) must never import from peripheral modules (kyc, fraud, social, billsplit, scheduling, notifications) — see docs/architecture.md §10.',
            },
            {
              from: { element: { type: 'users-module' } },
              disallow: { to: { element: { type: 'peripheral-module' } } },
              message:
                'Core modules (ledger, payments, auth, users) must never import from peripheral modules (kyc, fraud, social, billsplit, scheduling, notifications) — see docs/architecture.md §10.',
            },
            {
              from: { element: { type: 'transfers-module' } },
              disallow: { to: { element: { type: 'peripheral-module' } } },
              message:
                'Core modules (ledger, payments, auth, users, transfers) must never import from peripheral modules (kyc, fraud, social, billsplit, scheduling, notifications) — see docs/architecture.md §10 and docs/adr/0011-transfers-module-boundary.md.',
            },
            {
              from: { element: { type: 'users-module' } },
              disallow: { to: { element: { type: 'auth-module' } } },
              message:
                '`users` must never import from `auth` — `auth` depends on `users`, never the reverse, specifically to avoid a cycle (see docs/adr/0005-users-auth-split.md).',
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
            // *.module.ts is also allowed — a module's Module class is pure
            // Nest DI wiring (no business logic), and another core module
            // composing it into its own `imports: []` (e.g. auth importing
            // LedgerModule) is normal modular-monolith structure, not a
            // breach of "one exported service" — that rule is about
            // reaching into a module's internals, not about DI composition.
            // Four separate entries, not one with an array `type` — the
            // legacy entry-point rule's matcher throws
            // ("template.replaceAll is not a function") when `type` is an
            // array rather than a single string, a real bug in this
            // deprecated rule at the installed plugin version. Verified by
            // hitting it directly; splitting into single-string entries
            // avoids the broken code path entirely.
            {
              target: { type: 'ledger-module' },
              allow: '*.(service|module).ts',
            },
            {
              target: { type: 'payments-module' },
              allow: '*.(service|module).ts',
            },
            {
              target: { type: 'auth-module' },
              allow: '*.(service|module).ts',
            },
            {
              target: { type: 'users-module' },
              allow: '*.(service|module).ts',
            },
            {
              target: { type: 'transfers-module' },
              allow: '*.(service|module).ts',
            },
            {
              target: { type: 'peripheral-module' },
              allow: '*.(service|module).ts',
            },
            // shared/primitives and shared/events are explicitly the one
            // exception to module isolation (docs/architecture.md §10) —
            // without this, the default 'disallow' blocks every module from
            // importing the event bus or Money/etc, since 'shared' isn't a
            // target type either of the two policies above cover.
            { target: { type: 'shared' }, allow: '**/*' },
          ],
          message:
            "Only a module's exported <name>.service.ts is importable from outside that module — see docs/architecture.md §10.",
        },
      ],
    },
  },
);