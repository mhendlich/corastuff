# New (TypeScript) stack scaffold

This folder is the starting point for the migration described in `../ARCHITECTURE_MIGRATION.md`.

## What’s here

- `apps/web`: React + Vite + Mantine SPA
- `apps/worker`: BullMQ worker (Playwright-ready)
- `convex`: Convex schema/functions (auth + app API)
- `docker`: proxy/media container config (Caddy)
- `docker-compose.yml`: single-machine compose with shared `/data` volume

## Local dev (without Docker)

From `new/`:

1. Install deps: `pnpm install`
2. (Recommended) Watch-build shared TS packages: `pnpm dev:packages`
3. Run web dev server: `pnpm dev:web`
4. Run worker (needs Redis): `docker compose up -d redis` then `pnpm dev:worker`
5. Push Convex functions to the backend:
   - Self-hosted: `./scripts/bootstrap_convex_self_hosted.sh` (recommended)
   - Or: `pnpm dev:convex` (runs `convex dev`)

## Docker (single-machine)

From `new/`:

- Build + run core services: `docker compose up --build`
- Open: `http://localhost:8080`

Environment is configured via `new/.env` (start from `new/.env.example`).
