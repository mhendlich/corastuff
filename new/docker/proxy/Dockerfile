FROM node:20-bookworm-slim AS web-build

WORKDIR /app

COPY package.json /app/package.json
COPY pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY .npmrc /app/.npmrc
COPY pnpm-lock.yaml /app/pnpm-lock.yaml
COPY apps/web/package.json /app/apps/web/package.json
COPY apps/worker/package.json /app/apps/worker/package.json
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/tsconfig.json /app/packages/shared/tsconfig.json
COPY packages/queue/package.json /app/packages/queue/package.json
COPY packages/queue/tsconfig.json /app/packages/queue/tsconfig.json
COPY packages/scrapers/package.json /app/packages/scrapers/package.json
COPY packages/scrapers/tsconfig.json /app/packages/scrapers/tsconfig.json
COPY tsconfig.base.json /app/tsconfig.base.json
COPY apps/web/tsconfig.json /app/apps/web/tsconfig.json
COPY apps/web/vite.config.ts /app/apps/web/vite.config.ts
COPY apps/web/index.html /app/apps/web/index.html
COPY apps/web/postcss.config.cjs /app/apps/web/postcss.config.cjs
COPY apps/web/tailwind.config.cjs /app/apps/web/tailwind.config.cjs
COPY apps/web/public /app/apps/web/public
COPY apps/web/src /app/apps/web/src
COPY packages/shared/src /app/packages/shared/src
COPY packages/queue/src /app/packages/queue/src

RUN npm install -g pnpm@10.25.0
RUN pnpm install --frozen-lockfile --filter @corastuff/web...
RUN pnpm -r --filter @corastuff/shared --filter @corastuff/web build

FROM caddy:2.8-alpine

WORKDIR /srv
COPY --from=web-build /app/apps/web/dist /srv
COPY docker/proxy/Caddyfile /etc/caddy/Caddyfile
COPY docker/proxy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
