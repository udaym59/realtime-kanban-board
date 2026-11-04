# syntax=docker/dockerfile:1.7
# Multi-stage image for the Realtime Kanban API.
#   base    → node + openssl (for Prisma engine) + pnpm via corepack
#   deps    → cached pnpm install of only the api + shared workspaces
#   build   → copies source, generates Prisma Client
#   runtime → runs tsx (TS at runtime) — shared stays as workspace source
#
# Build context: repo root (so pnpm-workspace.yaml + lockfile are visible).
# Koyeb build command: use `packages/api/Dockerfile` as the Dockerfile path
# and leave the context as the repo root (default).

FROM node:22-alpine AS base
WORKDIR /app
# OpenSSL for Prisma's query engine; wget for the HEALTHCHECK probe
RUN apk add --no-cache openssl wget
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate

# ---------- deps ----------
# Cached across code-only changes — only invalidates when a package.json moves.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/api/package.json ./packages/api/
COPY packages/shared/package.json ./packages/shared/
COPY packages/web/package.json ./packages/web/
# Install only what the API runtime needs (api + shared + their deps)
RUN pnpm install --frozen-lockfile --filter=api... --filter=shared...

# ---------- build ----------
FROM deps AS build
COPY packages/shared ./packages/shared
COPY packages/api ./packages/api
# Generate the Prisma Client — no DB connection needed, just the schema file
RUN pnpm --filter api exec prisma generate

# ---------- runtime ----------
FROM build AS runtime
ENV NODE_ENV=production
# PORT is overridable at runtime (Koyeb may inject one). Defaults to 3001.
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" || exit 1

# tsx runs the TS directly; the `shared` workspace is consumed as .ts via
# pnpm's symlinked workspace resolution — no separate build step needed.
CMD ["pnpm", "--filter", "api", "exec", "tsx", "src/index.ts"]
