FROM oven/bun:1 AS base

WORKDIR /app

FROM base AS install

COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/miniapp/package.json ./apps/miniapp/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN bun install --frozen-lockfile

FROM install AS build

COPY tsconfig.json ./
COPY packages/db/src ./packages/db/src
COPY apps/server/src ./apps/server/src
COPY apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY apps/miniapp ./apps/miniapp
RUN bun run --cwd apps/miniapp build

FROM base AS runtime

ENV NODE_ENV=production

COPY package.json bun.lock ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/miniapp/package.json ./apps/miniapp/package.json
COPY packages/db/package.json ./packages/db/package.json
RUN bun install --frozen-lockfile --production

COPY apps/server/src ./apps/server/src
COPY packages/db/src ./packages/db/src
COPY packages/db/drizzle ./packages/db/drizzle
COPY scripts ./scripts
COPY --from=build /app/apps/miniapp/dist ./apps/miniapp/dist

# /app/data must exist in the image and be owned by bun (uid 1000) before USER is
# set. Compose mounts the sku_data named volume here, and Docker initialises a new
# volume from the image directory's ownership and mode -- so the volume comes up as
# 1000:1000 and needs no chown on the host. Do not turn this back into a bind mount.
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

EXPOSE 3000

CMD ["bun", "run", "apps/server/src/index.ts"]
