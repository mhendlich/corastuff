# New (TypeScript) stack scaffold

This folder is the starting point for the migration described in `../ARCHITECTURE_MIGRATION.md`.

## What’s here

- `apps/web`: React + Vite + Tailwind SPA scaffold
- `apps/worker`: BullMQ worker scaffold (Playwright-ready)
- `convex`: Convex schema/function placeholders (to be wired up)
- `docker`: proxy/media container config (Caddy)
- `docker-compose.yml`: single-machine compose with shared `/data` volume

## Local dev (without Docker)

From `new/`:

1. Install deps: `pnpm install`
2. Run web dev server: `pnpm dev:web`
3. Run worker (needs Redis): `docker compose up -d redis` then `pnpm dev:worker`

## Docker (single-machine)

From `new/`:

- Build + run core services: `docker compose up --build`
- Open: `http://localhost:8080`

Environment is configured via `new/.env` (start from `new/.env.example`).
