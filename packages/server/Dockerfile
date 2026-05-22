# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

RUN npm install -g pnpm@9

WORKDIR /app

# Copy workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server

# Generate Prisma client BEFORE tsc so types are available during compilation
RUN pnpm --filter @swarmvault/server prisma:generate
# pnpm stores the generated client in its virtual store — find it and copy to a
# known real path so Docker can COPY it across stages without following symlinks
RUN find /app/node_modules/.pnpm -maxdepth 6 -type d -name ".prisma" | head -1 | \
    xargs -I{} cp -r {} /app/.prisma-client
# Build shared first, then server
RUN pnpm --filter @swarmvault/shared build
RUN pnpm --filter @swarmvault/server build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

# openssl is required by the Prisma query engine for libssl detection
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Copy compiled output and Prisma client
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/.prisma-client ./packages/server/node_modules/.prisma
COPY packages/server/prisma ./packages/server/prisma

WORKDIR /app/packages/server

EXPOSE 3000

# Run migrations then start — entrypoint script handles this atomically
COPY packages/server/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
