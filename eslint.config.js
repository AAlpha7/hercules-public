// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.claude/**', 'tmp/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Anti-cheating / silent-failure guardrails (SPEC §9.5) — keep them honest even in the daemon itself.
      '@typescript-eslint/no-explicit-any': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  {
    // Architectural lint (SPEC §1): the domain layer is pure — it MUST NOT import from
    // outer layers (control repo IO, git, http server, adapters). Enforced mechanically,
    // not by convention. To fix a violation: move the shared type into src/domain, or
    // invert the dependency so the outer layer depends on domain instead.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/control/**', '**/server/**', '**/adapters/**', '**/orchestrator/**', '**/web/**'],
              message:
                'domain is a pure layer and must not import from outer layers (control/server/adapters/orchestrator/web). Move shared types into src/domain or invert the dependency.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
