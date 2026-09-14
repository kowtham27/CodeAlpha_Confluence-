# syntax=docker/dockerfile:1

# ---- base: pnpm on Node 24 -------------------------------------------------
FROM node:24-alpine AS base
RUN corepack enable && apk add --no-cache openssl
WORKDIR /app

# ---- deps: install with the lockfile, cached across source edits ------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
COPY packages/shared/package.json    packages/shared/
COPY packages/crypto/package.json    packages/crypto/
# sharing=locked: api and web build in parallel and would otherwise write the
# same store concurrently, leaving truncated package.json files behind.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

# ---- dev: hot reload, source bind-mounted by compose.override --------------
FROM deps AS dev
COPY . .
RUN pnpm --filter @confluence/api exec prisma generate
EXPOSE 4000
CMD ["pnpm", "--filter", "@confluence/api", "dev"]

# ---- build -----------------------------------------------------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @confluence/api exec prisma generate \
 && pnpm --filter @confluence/shared build \
 && pnpm --filter @confluence/crypto build \
 && pnpm --filter @confluence/api build

# ---- prod: non-root, prod deps only ----------------------------------------
FROM base AS prod
ENV NODE_ENV=production
# pnpm is not flat: the API's own dependencies are symlinks in
# apps/api/node_modules pointing into the root .pnpm store. Both are needed.
COPY --from=build /app/node_modules                 ./node_modules
COPY --from=build /app/apps/api/node_modules        ./apps/api/node_modules
COPY --from=build /app/packages                     ./packages
COPY --from=build /app/apps/api/dist                ./apps/api/dist
COPY --from=build /app/apps/api/src/generated           ./apps/api/generated
COPY --from=build /app/apps/api/prisma              ./apps/api/prisma
COPY --from=build /app/apps/api/package.json        ./apps/api/
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
