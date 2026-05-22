#!/bin/sh
set -e

# ── Source Docker secrets into environment variables ──────────────────────────
# This lets config.ts read from process.env without any code changes.
if [ -f /run/secrets/jwt_secret ]; then
  export JWT_SECRET=$(cat /run/secrets/jwt_secret)
fi
if [ -f /run/secrets/postgres_password ]; then
  PG_PASS=$(cat /run/secrets/postgres_password)
  export DATABASE_URL="postgresql://swarmvault:${PG_PASS}@postgres:5432/swarmvault"
fi
if [ -f /run/secrets/redis_password ]; then
  REDIS_PASS=$(cat /run/secrets/redis_password)
  export REDIS_URL="redis://:${REDIS_PASS}@redis:6379"
fi

echo "[entrypoint] Running Prisma migrations..."
# Use pnpm exec so pnpm resolves the prisma binary from @swarmvault/server's
# own node_modules — never npx, which downloads the latest (incompatible) CLI.
cd /app/packages/server && pnpm exec prisma migrate deploy --schema=./prisma/schema.prisma

echo "[entrypoint] Starting SwarmVault server..."
exec node dist/index.js
