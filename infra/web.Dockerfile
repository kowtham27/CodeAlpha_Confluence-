# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

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

FROM deps AS dev
COPY . .
EXPOSE 5173
CMD ["pnpm", "--filter", "@confluence/web", "dev", "--host", "0.0.0.0"]

FROM deps AS build
COPY . .
RUN pnpm --filter @confluence/shared build \
 && pnpm --filter @confluence/crypto build \
 && pnpm --filter @confluence/web build

# Static assets only. The strict CSP from Phase 7 gets added to this nginx
# config, not to the app, so it applies to every response including errors.
FROM nginx:1.27-alpine AS prod
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
