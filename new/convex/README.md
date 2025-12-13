# Convex

This folder contains the Convex schema and will hold queries/mutations/actions.

Agents will decide whether to:

- use Convex dev (cloud) during development, or
- self-host the Convex backend and wire it into `docker-compose.yml`.

Current status:

- Schema exists in `convex/schema.ts`.
- Minimal functions exist for `sources` and `runs` (including an action to enqueue BullMQ jobs).

## Self-hosted (local Docker)

`new/docker-compose.yml` includes `convex-backend` and `convex-dashboard`.

Bootstrap (generates an admin key, writes `new/.env.local`, pushes schema/functions, seeds demo sources):

- From `new/`: `./scripts/bootstrap_convex_self_hosted.sh`
