# shop-keepr

A Nuxt 4 application.

## Requirements

- Node `>=22` (see `.nvmrc`)
- pnpm `12.3.4` (pinned via `packageManager`; run `corepack enable`)

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev          # dev server on http://localhost:3000
pnpm build        # production build
pnpm preview      # preview the production build
```

## Checks

```bash
pnpm lint         # eslint (antfu config, tabs + semicolons)
pnpm lint:fix     # eslint --fix
pnpm typecheck    # vue-tsc via nuxt typecheck
pnpm test         # vitest unit tests (test/unit)
pnpm test:e2e     # playwright e2e tests (test/e2e)
```

## Agents

Conventions for AI agents working in this repo live in `AGENTS.md` and `docs/agents/`.
