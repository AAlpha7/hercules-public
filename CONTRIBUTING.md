# Contributing

Thank you for your interest. Hercules is experimental reference code, and
reviews are best-effort.

## Before you open a pull request

1. Use Node.js 20.10 or later and pnpm through corepack (`corepack enable`).
2. Run `pnpm install`, then `pnpm check`. Run `pnpm check:full` for larger
   changes.
3. Keep each change small and focused. One topic per pull request.
4. A bug fix needs a test that fails before the fix and passes after it.
5. Follow the house rules in [`AGENTS.md`](./AGENTS.md): TypeScript strict
   mode, no `any`, no empty `catch`, no `eslint-disable`, no `.skip`, no
   `@ts-ignore`.
6. Do not commit secrets, tokens, private hostnames, or personal data.

## Issues

Open a GitHub issue for bugs and questions. Include your Node.js version, the
command you ran, and the full error output.

Do not report security problems in a public issue. See
[`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT
License in [`LICENSE`](./LICENSE).
