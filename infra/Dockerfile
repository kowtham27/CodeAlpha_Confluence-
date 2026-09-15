# syntax=docker/dockerfile:1

# One Dockerfile, two production targets: api and web.
# Both images build FROM the same `deps` stage, so a dependency change installs
# and supply-chain-verifies packages once instead of once per image.

# ---- base -------------------------------------------------------------------
FROM node:24-alpine AS base
RUN corepack enable && apk add --no-cache openssl
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app

# ---- deps: the expensive layer ----------------------------------------------
# Rebuilt only when a manifest or the lockfile changes. Two persistent caches
# make even that rebuild cheap:
#   /pnpm/store          package tarballs
#   /root/.cache/pnpm    registry metadata + pnpm's record of lockfiles that
#                        already passed the minimumReleaseAge check. Without
#                        it, every dependency change re-fetches metadata for
#                        all ~550 lockfile entries (9+ minutes on a slow link).
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json        apps/api/
COPY apps/web/package.json        apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
# sharing=locked: never let two builds write the same store at once; that is
# how truncated package.json files got into the cache before.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store,sharing=locked \
    --mount=type=cache,id=pnpm-cache,target=/root/.cache/pnpm,sharing=locked \
    pnpm config set store-dir /pnpm/store && pnpm install --frozen-lockfile

# ---- source: shared by every target below -----------------------------------
FROM deps AS source
COPY . .
RUN pnpm --filter @confluence/api exec prisma generate \
 && pnpm --filter @confluence/shared build \
 && pnpm --filter @confluence/crypto build

# ---- production builds ------------------------------------------------------
FROM source AS api-build
RUN pnpm --filter @confluence/api build

FROM source AS web-build
RUN pnpm --filter @confluence/web build

# ---- api: non-root, compiled output only ------------------------------------
FROM base AS api
ENV NODE_ENV=production
# pnpm is not flat: the API's own dependencies are symlinks in
# apps/api/node_modules pointing into the root .pnpm store. Both are needed.
COPY --from=api-build /app/node_modules              ./node_modules
COPY --from=api-build /app/apps/api/node_modules     ./apps/api/node_modules
COPY --from=api-build /app/packages                  ./packages
COPY --from=api-build /app/apps/api/dist             ./apps/api/dist
COPY --from=api-build /app/apps/api/src/generated    ./apps/api/src/generated
COPY --from=api-build /app/apps/api/prisma           ./apps/api/prisma
COPY --from=api-build /app/apps/api/package.json     ./apps/api/
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]

# ---- web: static files behind nginx -----------------------------------------
FROM nginx:1.27-alpine AS web
# The security headers are a template: the image's entrypoint substitutes the
# origins below (override them at run time) into /etc/nginx/snippets.
ENV API_ORIGIN=http://localhost:4000 \
    API_WS_ORIGIN=ws://localhost:4000 \
    STORAGE_ORIGIN=http://localhost:9000 \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/snippets
RUN mkdir -p /etc/nginx/snippets
COPY infra/security-headers.conf.template /etc/nginx/templates/security-headers.conf.template
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
