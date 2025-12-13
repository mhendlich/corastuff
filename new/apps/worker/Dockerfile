FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

COPY package.json /app/package.json
COPY pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY .npmrc /app/.npmrc
COPY pnpm-lock.yaml /app/pnpm-lock.yaml
COPY tsconfig.base.json /app/tsconfig.base.json
COPY apps/web/package.json /app/apps/web/package.json
COPY apps/worker/package.json /app/apps/worker/package.json
COPY apps/worker/tsconfig.json /app/apps/worker/tsconfig.json
COPY packages/shared/package.json /app/packages/shared/package.json
COPY packages/shared/tsconfig.json /app/packages/shared/tsconfig.json
COPY packages/queue/package.json /app/packages/queue/package.json
COPY packages/queue/tsconfig.json /app/packages/queue/tsconfig.json
COPY packages/scrapers/package.json /app/packages/scrapers/package.json
COPY packages/scrapers/tsconfig.json /app/packages/scrapers/tsconfig.json

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install -g pnpm@10.25.0
RUN pnpm install --frozen-lockfile --filter @corastuff/worker...

COPY apps/worker/src /app/apps/worker/src
COPY packages/shared/src /app/packages/shared/src
COPY packages/queue/src /app/packages/queue/src
COPY packages/scrapers/src /app/packages/scrapers/src

ENV NODE_ENV=production

RUN pnpm -r --filter @corastuff/shared --filter @corastuff/queue --filter @corastuff/scrapers --filter @corastuff/worker build

CMD ["pnpm", "--filter", "@corastuff/worker", "start"]
