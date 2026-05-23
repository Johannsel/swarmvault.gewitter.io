# SwarmVault

> Distributed peer-to-peer encrypted cloud storage — your data lives on the swarm, not a single server.

SwarmVault is an **Electron desktop app** that automatically syncs a folder across a network of contributor nodes. Files are split into shards, encrypted client-side with **AES-256-GCM**, and distributed using **Reed-Solomon erasure coding** (4 data + 2 parity shards in production; 2+1 during beta). A central orchestration server routes transfers and manages rewards — but it never sees your plaintext data.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Storage Tiers](#storage-tiers)
- [Reward System](#reward-system)
- [Architecture](#architecture)
- [Monorepo Structure](#monorepo-structure)
- [Tech Stack](#tech-stack)
- [API Reference](#api-reference)
- [Database Schema](#database-schema)
- [Quick Start (Development)](#quick-start-development)
- [Production Deployment](#production-deployment)
- [Building Client Applications](#building-client-applications)
- [Security Model](#security-model)
- [Contributing](#contributing)
- [Known Constraints](#known-constraints)

---

## How It Works

```
User drops file into sync folder
        │
        ▼
Desktop app splits file into shards (2 equal halves — beta; 4 data shards in production)
        │
        ▼
Each shard encrypted with AES-256-GCM
  Master key generated client-side, never sent to server
  Per-shard key derived from master key + shard index
        │
        ▼
Reed-Solomon parity shards added (2 data + 1 parity — beta; 4+2 in production)
  Any 2 of 3 shards can reconstruct the file
        │
        ▼
Server selects online storage nodes — 3 during beta, 6 in production (load-balanced)
        │
        ▼
Each encrypted shard relayed over WebSocket to a node
Server verifies shard integrity via SHA-256 before relay
        │
        ▼
File marked "available" — encrypted metadata stored server-side
Plaintext never touches the server
```

**Download** reverses the process: the server fetches encrypted shards from storage nodes, streams them back, the desktop app decrypts and Reed-Solomon-reconstructs the original file.

---

## Storage Tiers

| Tier | Name      | Intended Hardware          | Availability            | Reward Multiplier |
| ---- | --------- | -------------------------- | ----------------------- | ----------------- |
| 1    | **Vault** | Homeserver / always-on NAS | Always accessible       | 1.5×              |
| 2    | **Swarm** | Consumer PC                | Best-effort / claimable | 1.0×              |

### Swarm Claim Flow

Swarm-tier files are stored on consumer PCs that may be offline. To retrieve one:

1. User marks the file as **claimed** in the desktop app
2. Server queues a `retrieval_job`
3. When enough nodes holding the required shards come back online, the server reassembles and pushes the file to the user's sync folder
4. Optional: **shutdown after download** flag supported for automation

---

## Reward System

Nodes that contribute storage earn **SwarmCredits**, which expand their storage quota beyond the 2 GB free tier.

```
credits_per_hour = (avg_pledged_gb × uptime_pct × tier_multiplier) / 24
```

| Variable                           | Value            |
| ---------------------------------- | ---------------- |
| Base storage quota                 | 2 GB             |
| Credits per GB contributed per day | 1                |
| 1 SwarmCredit =                    | 1 GB extra quota |
| Vault tier multiplier              | 0.5              |
| Swarm tier multiplier              | 0.2              |
| Node heartbeat timeout             | 90 seconds       |

Credits are calculated hourly by a BullMQ worker and stored as `contribution_snapshots`.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                     SwarmVault Server                            │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │  Fastify    │  │  PostgreSQL  │  │   Redis + BullMQ     │   │
│  │  REST API   │  │  via Prisma  │  │  (queues, heartbeat, │   │
│  │  + WS relay │  │              │  │   reward workers)    │   │
│  └─────────────┘  └──────────────┘  └──────────────────────┘   │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTPS + WSS
              ┌────────────┼────────────┐
              │            │            │
       ┌──────▼──────┐ ┌───▼─────┐ ┌───▼─────┐
       │  Desktop    │ │Desktop  │ │Desktop  │   ···
       │  (Vault)    │ │(Swarm)  │ │(Swarm)  │
       │  Node A     │ │Node B   │ │Node C   │
       └─────────────┘ └─────────┘ └─────────┘
```

### Key data flows

| Flow         | Path                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| Upload       | Client → REST `POST /api/v1/files` → `POST /api/v1/chunks` → WS relay → node            |
| Download     | Client → REST `GET /api/v1/files/:id/download` → WS relay ← node                        |
| Heartbeat    | Desktop node → REST `POST /api/v1/nodes/heartbeat` (every 30 s)                         |
| Node auth    | WS handshake with `nodeId` + `relayToken` header                                        |
| File sharing | Client uploads decrypted bytes → server stores as shadow copy for 7 days → public token |

---

## Monorepo Structure

```
swarmvault.gewitter.io/
├── packages/
│   ├── shared/               Pure TypeScript library — shared between server + desktop
│   │   └── src/
│   │       ├── types.ts      All shared TypeScript interfaces and enums
│   │       ├── constants.ts  Shard size, node thresholds, reward constants
│   │       ├── crypto.ts     AES-256-GCM encrypt/decrypt helpers
│   │       └── erasure.ts    Reed-Solomon GF(2^8) encode/decode (pure TS)
│   │
│   ├── server/               Fastify orchestration server
│   │   ├── src/
│   │   │   ├── index.ts      App entry, WebSocket handler, BullMQ workers
│   │   │   ├── config.ts     Zod-validated env config
│   │   │   ├── database.ts   Prisma client singleton
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts       POST /register, POST /login, GET /me
│   │   │   │   ├── files.ts      File CRUD + claim + trash
│   │   │   │   ├── chunks.ts     Shard upload relay (with SHA-256 integrity check)
│   │   │   │   ├── nodes.ts      Node registration, listing, heartbeat
│   │   │   │   ├── retrieval.ts  Shard download relay
│   │   │   │   ├── rewards.ts    Balance + snapshot history
│   │   │   │   └── sharing.ts    Public share token + shadow copy
│   │   │   └── services/
│   │   │       ├── distribution.ts  Node selection, shard assignment
│   │   │       ├── nodes.ts         Node health / offline detection
│   │   │       ├── retrieval.ts     Retrieval job orchestration
│   │   │       └── rewards.ts       Hourly credit calculation worker
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   ├── Dockerfile
│   │   ├── docker-entrypoint.sh
│   │   ├── docker-compose.yml        (dev — postgres + redis only)
│   │   ├── docker-compose.prod.yml   (production — Traefik labels)
│   │   └── .env.prod.example
│   │
│   └── desktop/              Electron 33 + React 18 + Vite + Tailwind
│       └── src/
│           ├── main/
│           │   ├── index.ts    Electron main process, tray icon, window
│           │   ├── ipc.ts      IPC bridge handlers
│           │   ├── storage.ts  electron-store settings persistence
│           │   └── sync.ts     File watcher, upload/download, WebSocket client
│           ├── preload/
│           │   └── index.ts    contextBridge API surface
│           └── renderer/
│               ├── App.tsx
│               └── components/
│                   ├── Dashboard.tsx    Storage overview, node status
│                   ├── FileManager.tsx  Active files + trash tabs                    ├── Info.tsx         Live swarm stats + how it works│                   ├── Rewards.tsx      Credit balance + chart
│                   ├── Settings.tsx     Server URL, sync folder, node config
│                   └── SyncSelector.tsx Selective sync per-file
├── package.json    (pnpm workspaces root)
├── pnpm-workspace.yaml
├── turbo.json
└── .nvmrc          (Node 20)
```

---

## Tech Stack

| Layer                  | Technology                            | Version |
| ---------------------- | ------------------------------------- | ------- |
| Package manager        | pnpm                                  | 9       |
| Monorepo orchestration | Turborepo                             | 2.x     |
| Runtime                | Node.js                               | 20      |
| Language               | TypeScript                            | 5.x     |
| Server framework       | Fastify                               | 5       |
| ORM                    | Prisma                                | 6       |
| Database               | PostgreSQL                            | 16      |
| Cache / Queue          | Redis + BullMQ                        | 7 / 5   |
| Real-time              | WebSocket (`@fastify/websocket`)      | 11      |
| Auth                   | `@fastify/jwt` (HMAC-SHA256)          | 9       |
| Password hashing       | argon2                                | 0.41    |
| Validation             | Zod                                   | 3       |
| Desktop shell          | Electron                              | 33      |
| Desktop UI             | React                                 | 18      |
| Desktop build          | Vite                                  | 6       |
| Desktop styles         | Tailwind CSS                          | 3       |
| File watching          | chokidar                              | 4       |
| Desktop settings       | electron-store                        | 8       |
| Encryption             | AES-256-GCM (Node.js `crypto`)        | —       |
| Erasure coding         | Reed-Solomon GF(2^8), pure TypeScript | —       |

---

## API Reference

All authenticated routes require `Authorization: Bearer <jwt>`.

### Auth — `/api/v1/auth`

| Method | Path        | Auth | Description                              |
| ------ | ----------- | ---- | ---------------------------------------- |
| `POST` | `/register` | —    | Create account. Rate-limited: 10 req/min |
| `POST` | `/login`    | —    | Get JWT. Rate-limited: 10 req/min        |
| `GET`  | `/me`       | ✓    | Current user profile + quota             |

**Register / Login body:**

```json
{ "email": "user@example.com", "username": "alice", "password": "supersecret123" }
```

---

### Files — `/api/v1/files`

| Method   | Path             | Auth | Description                                  |
| -------- | ---------------- | ---- | -------------------------------------------- |
| `GET`    | `/`              | ✓    | List files (excluding trashed)               |
| `POST`   | `/`              | ✓    | Create file record, receive shard assignment |
| `DELETE` | `/:id`           | ✓    | Soft-delete (move to trash)                  |
| `POST`   | `/:id/restore`   | ✓    | Restore from trash                           |
| `DELETE` | `/:id/permanent` | ✓    | Permanently delete + free storage            |
| `GET`    | `/:id/download`  | ✓    | Download (relay encrypted shards)            |
| `POST`   | `/:id/claim`     | ✓    | Queue retrieval job for Swarm-tier file      |
| `POST`   | `/:id/share`     | ✓    | Create public share (7-day shadow copy)      |
| `PUT`    | `/:id/share`     | ✓    | Update shadow copy content                   |
| `DELETE` | `/:id/share`     | ✓    | Revoke share                                 |

**Create file body:**

```json
{
  "name": "photo.jpg",
  "path": "/photos/photo.jpg",
  "mimeType": "image/jpeg",
  "sizeBytes": 4194304,
  "contentHash": "<hex SHA-256 of plaintext>",
  "totalShards": 2,
  "parityShards": 1,
  "encryptedMasterKey": "<base64url>"
}
```

**Response includes** `assignedNodes` — a list of node IDs + relay tokens for each shard.

---

### Chunks — `/api/v1/chunks`

| Method | Path | Auth | Description                                |
| ------ | ---- | ---- | ------------------------------------------ |
| `POST` | `/`  | ✓    | Upload one encrypted shard (relay to node) |

Headers required:

- `X-File-Id`: file record ID
- `X-Shard-Index`: shard number (0-based)
- `X-Node-Id`: target node ID
- `X-Chunk-Hash`: hex SHA-256 of the raw shard bytes (verified server-side)
- `Content-Type: application/octet-stream`

---

### Nodes — `/api/v1/nodes`

| Method | Path            | Auth | Description                             |
| ------ | --------------- | ---- | --------------------------------------- |
| `POST` | `/`             | ✓    | Register a storage node                 |
| `GET`  | `/`             | ✓    | List all nodes (including uptime stats) |
| `POST` | `/heartbeat`    | ✓    | Update node status + used bytes         |
| `GET`  | `/swarm-stats`  | —    | Aggregate swarm stats (public)          |
| `GET`  | `/online-count` | —    | Count of currently online nodes (public)|

**Heartbeat body:**

```json
{
  "nodeId": "cmpgwpt5f...",
  "status": "online",
  "usedBytes": 1073741824,
  "pledgedBytes": 10737418240,
  "availableDiskBytes": 50000000000
}
```

---

### WebSocket — `GET /ws`

Used by storage nodes (not the uploader client). Authentication is via query params or headers on upgrade.

**Authenticate:**

```json
{ "type": "auth", "payload": { "nodeId": "...", "relayToken": "..." } }
```

**Server → Node messages:**

`chunk_relay` is sent as a **binary WebSocket frame** (avoids the 33% base64 overhead for large shards):

```
[4 bytes: metadata JSON length, big-endian uint32]
[metadata JSON bytes]  — { type, fileId, shardIndex, chunkHash, isData, ackNonce }
[raw encrypted shard bytes]
```

All other server→node messages are JSON text frames:

```json
{ "type": "chunk_request", "payload": { "fileId": "...", "shardIndex": 0, "requestNonce": "..." } }
```

**Node → Server messages** (all JSON text frames):

```json
{ "type": "chunk_ack",      "payload": { "fileId": "...", "shardIndex": 0, "ackNonce": "...", "success": true, "chunkHash": "..." } }
{ "type": "chunk_response", "payload": { "fileId": "...", "shardIndex": 0, "requestNonce": "...", "data": "<base64>", "chunkHash": "..." } }
{ "type": "heartbeat",      "payload": { "nodeId": "...", "relayToken": "...", "status": "online", "usedBytes": 0, "pledgedBytes": 0 } }
```

---

### Rewards — `/api/v1/rewards`

| Method | Path | Auth | Description                                |
| ------ | ---- | ---- | ------------------------------------------ |
| `GET`  | `/`  | ✓    | Balance + last 48 hourly snapshots + quota |

---

### Public Share — `/api/v1/share`

| Method | Path      | Auth | Description                         |
| ------ | --------- | ---- | ----------------------------------- |
| `GET`  | `/:token` | —    | Download shadow copy (7-day expiry) |

---

## Database Schema

Key models in `packages/server/prisma/schema.prisma`:

| Model                  | Description                                |
| ---------------------- | ------------------------------------------ |
| `User`                 | Account with storage quota and used bytes  |
| `StorageNode`          | Contributor node with tier, uptime, pledge |
| `SwarmFile`            | File metadata + encrypted master key       |
| `FileChunk`            | Per-shard record with hash                 |
| `ChunkLocation`        | Maps chunk → node (many-to-many)           |
| `RetrievalJob`         | Queued Swarm-tier download job             |
| `RewardBalance`        | Current credits per user                   |
| `ContributionSnapshot` | Hourly credit calculation history          |
| `SharedFile`           | Shadow copy for public share links         |

---

## Quick Start (Development)

### Prerequisites

- Node.js ≥ 20 (`nvm use` will pick the right version from `.nvmrc`)
- pnpm ≥ 9 (`npm install -g pnpm`)
- Docker + Docker Compose

### 1 — Install dependencies

```bash
pnpm install
```

### 2 — Start PostgreSQL + Redis

```bash
cd packages/server
docker compose up -d
```

### 3 — Configure the server

```bash
# packages/server/.env.prod.example documents every variable — for dev, create a minimal .env:
cat > packages/server/.env <<'EOF'
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
DATABASE_URL=postgresql://swarmvault:swarmvault@localhost:5432/swarmvault
REDIS_URL=redis://localhost:6379
JWT_SECRET=$(openssl rand -base64 48)
JWT_EXPIRY=7d
CHUNK_TEMP_DIR=/tmp/swarmvault-chunks
EOF
```

> `packages/server/.env.prod.example` describes every variable and the production secret injection strategy.

### 4 — Run migrations

```bash
cd packages/server
pnpm prisma migrate dev
```

### 5 — Start everything

```bash
# From the monorepo root:
pnpm dev
```

Turborepo starts all three packages in parallel:

- `@swarmvault/shared` — tsup watch, rebuilds on change
- `@swarmvault/server` — tsx watch on port 3000
- `@swarmvault/desktop` — tsc watch + Vite (port 5173) + Electron

> **Note:** If port 5173 is already in use, kill it first:
>
> ```bash
> lsof -ti:5173 | xargs kill -9
> ```

### Running packages individually

```bash
# Server only
cd packages/server && pnpm dev

# Desktop only (server must be running)
cd packages/desktop && pnpm dev

# Shared library watch
cd packages/shared && pnpm dev
```

### Prisma helpers

```bash
cd packages/server
pnpm prisma studio          # GUI database browser
pnpm prisma migrate dev     # create + apply a migration
pnpm prisma migrate reset   # reset DB (dev only!)
```

---

## Production Deployment

Production uses Docker + the existing **Traefik** reverse proxy. TLS certificates are issued automatically by Traefik via Let's Encrypt.

### Prerequisites on the server

- Docker + Docker Compose
- A running Traefik container on the external `traefik` network with `websecure` entrypoint and `leresolver` cert resolver
- DNS record: `api.swarmvault.gewitter.io` → server IP

### 1 — Clone the repo

```bash
git clone <repo-url> swarmvault
cd swarmvault/packages/server
```

### 2 — Create Docker secrets

```bash
mkdir .secrets
openssl rand -base64 64 | tr -d '\n' > .secrets/jwt_secret.txt
openssl rand -base64 32 | tr -d '\n' > .secrets/postgres_password.txt
openssl rand -base64 32 | tr -d '\n' > .secrets/redis_password.txt
chmod 600 .secrets/*.txt
```

> Never commit `.secrets/` — it is in `.gitignore`.

### 3 — Build and start

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

Traefik auto-discovers the container labels and routes `https://api.swarmvault.gewitter.io` to the server. Prisma migrations run automatically on container start before the Node process begins.

### What the production stack contains

| Service    | Image                   | Notes                                 |
| ---------- | ----------------------- | ------------------------------------- |
| `server`   | Built from `Dockerfile` | Multi-stage, prod deps only           |
| `postgres` | `postgres:16-alpine`    | Volume `db-swarmvault`                |
| `redis`    | `redis:7-alpine`        | AOF persistence, password from secret |

**No nginx** — Traefik handles TLS termination and WebSocket proxying natively.

### Useful commands

```bash
# View logs
docker compose -f docker-compose.prod.yml logs -f server

# Run a migration manually
docker compose -f docker-compose.prod.yml exec server pnpm exec prisma migrate deploy

# Open Prisma studio remotely (tunnel port 5555)
docker compose -f docker-compose.prod.yml exec server pnpm exec prisma studio --port 5555

# Stop everything
docker compose -f docker-compose.prod.yml down
```

---

## Building Client Applications

The desktop client is built with **electron-builder**. The output lands in `packages/desktop/release/`; copy the resulting installers to `releases/latest/` (see [Releases Folder](#releases-folder)) for distribution.

### Prerequisites

| Requirement  | Version | Notes                                                                                            |
| ------------ | ------- | ------------------------------------------------------------------------------------------------ |
| Node.js      | ≥ 20    | `nvm use` reads `.nvmrc`                                                                         |
| pnpm         | ≥ 9     | `npm install -g pnpm`                                                                            |
| macOS host   | —       | **Required** for `.dmg` / `.icns` builds (Apple toolchain)                                       |
| Windows host | —       | Recommended for NSIS installer signing; cross-compile from macOS/Linux works for unsigned builds |

### Required icon assets

Place these files in `packages/desktop/assets/` before building:

| File            | Size                   | Platform                    |
| --------------- | ---------------------- | --------------------------- |
| `icon.ico`      | ≥ 256×256 (multi-size) | Windows ✅ already present  |
| `icon.icns`     | 512×512 (retina)       | macOS                       |
| `icon.png`      | 256×256 minimum        | Linux                       |
| `tray-icon.png` | 16×16                  | All platforms (system tray) |

> Generate `.icns` from a 1024×1024 PNG:
>
> ```bash
> mkdir icon.iconset
> sips -z 16 16 icon.png --out icon.iconset/icon_16x16.png
> sips -z 32 32 icon.png --out icon.iconset/icon_16x16@2x.png
> sips -z 32 32 icon.png --out icon.iconset/icon_32x32.png
> sips -z 64 64 icon.png --out icon.iconset/icon_32x32@2x.png
> sips -z 128 128 icon.png --out icon.iconset/icon_128x128.png
> sips -z 256 256 icon.png --out icon.iconset/icon_128x128@2x.png
> sips -z 256 256 icon.png --out icon.iconset/icon_256x256.png
> sips -z 512 512 icon.png --out icon.iconset/icon_256x256@2x.png
> sips -z 512 512 icon.png --out icon.iconset/icon_512x512.png
> sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png
> iconutil -c icns icon.iconset -o packages/desktop/assets/icon.icns
> ```

### 1 — Install and build dependencies

Run from the **monorepo root**:

```bash
pnpm install
pnpm --filter @swarmvault/shared build
pnpm --filter @swarmvault/desktop build
```

This compiles the shared TypeScript library and then runs `tsc` + Vite for the desktop renderer and main process.

### 2 — Package the installer

Run from `packages/desktop/`:

```bash
cd packages/desktop
```

#### macOS (DMG — Intel + Apple Silicon)

```bash
# Both architectures (requires macOS host)
npx electron-builder --mac --x64 --arm64

# Intel only
npx electron-builder --mac --x64

# Apple Silicon only
npx electron-builder --mac --arm64
```

Outputs:

- `release/SwarmVault-<version>.dmg` (Intel)
- `release/SwarmVault-<version>-arm64.dmg` (Apple Silicon)

#### Windows (NSIS installer)

```bash
# 64-bit only (recommended)
npx electron-builder --win --x64

# 32-bit only
npx electron-builder --win --ia32

# Both architectures
npx electron-builder --win --x64 --ia32
```

Outputs:

- `release/SwarmVault Setup <version>.exe` (NSIS installer with optional install directory)

> Cross-compiling Windows installers from macOS or Linux works for **unsigned** builds.
> Code-signed builds require either a Windows host with an EV certificate or a cloud signing service.

#### Linux (AppImage + .deb)

```bash
npx electron-builder --linux
```

Outputs:

- `release/SwarmVault-<version>.AppImage`
- `release/SwarmVault-<version>.deb`

### 3 — Copy to releases folder

```bash
# From monorepo root
cp packages/desktop/release/*.exe releases/latest/windows/ 2>/dev/null || true
cp packages/desktop/release/*.dmg releases/latest/macos/ 2>/dev/null || true
cp packages/desktop/release/*.AppImage packages/desktop/release/*.deb releases/latest/linux/ 2>/dev/null || true
```

### One-liner: build all platforms (macOS host)

```bash
# From monorepo root
pnpm install && \
pnpm --filter @swarmvault/shared build && \
pnpm --filter @swarmvault/desktop build && \
cd packages/desktop && \
npx electron-builder --mac --win --linux
```

---

## Releases Folder

Pre-built installers are kept in `releases/latest/` for distribution:

```
releases/
└── latest/
    ├── windows/   # SwarmVault Setup <version>.exe
    ├── macos/     # SwarmVault-<version>.dmg, SwarmVault-<version>-arm64.dmg
    └── linux/     # SwarmVault-<version>.AppImage, SwarmVault-<version>.deb
```

For automated distribution via GitHub Releases, configure `publish` in `packages/desktop/electron-builder.yml` with your repository details.

---

## Security Model

### Encryption

- Files are **never decrypted on the server**. The server stores and relays only ciphertext.
- Each file has a 256-bit master key generated client-side and stored encrypted on the server (only the owning client can decrypt it).
- Each shard uses a unique IV derived from `masterKey + shardIndex`, preventing key+IV reuse across shards.

### Integrity

- The desktop client computes a SHA-256 hash of each shard before upload and sends it as `X-Chunk-Hash`.
- The server recomputes the hash and rejects shards that don't match (HTTP 400).

### Authentication

- JWTs are HMAC-SHA256 signed. Secret is ≥ 64 random bytes in production.
- Auth routes (`/register`, `/login`) are rate-limited to 10 requests/minute per IP.
- Global rate limit: 200 requests/minute.
- WebSocket connections from storage nodes are authenticated with `nodeId` + `relayToken`. Messages from unauthenticated sockets are rejected.

### Path traversal

- File paths supplied by the server during downloads are validated against `syncDir` using `path.resolve()` before any write occurs.

### File sharing

- Shared files use `filename*=UTF-8''...` (RFC 5987) in `Content-Disposition` to prevent header injection from non-ASCII filenames.
- Shadow copies expire after 7 days and are stored server-side in decrypted form only for the sharing window.

---

## Contributing

### Branches

- `main` — stable
- `dev` — active development, open PRs against this branch

### Code style

- TypeScript strict mode throughout
- No `any` without a comment explaining why
- Zod for all external input validation (HTTP bodies, env vars)
- Prisma transactions for any multi-table write

### Adding a new API route

1. Create `packages/server/src/routes/<name>.ts`
2. Export an `async function <name>Routes(fastify: FastifyInstance)`
3. Register it in `packages/server/src/index.ts` with the appropriate prefix
4. Add types to `packages/shared/src/types.ts` if shared with desktop

### Adding a new IPC channel

1. Add handler in `packages/desktop/src/main/ipc.ts`
2. Expose it in `packages/desktop/src/preload/index.ts` via `contextBridge`
3. Add the type to the `Window` augmentation in `packages/desktop/src/renderer/globals.d.ts`

### Running type checks across all packages

```bash
pnpm typecheck
```

---

## Known Constraints

| Constraint            | Detail                                                                                                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Min nodes for upload  | **3** online nodes required (2 data + 1 parity — beta; production will use 6)                                                                                                                                   |
| JWT expiry            | 7 days, no refresh token — users must re-login after expiry                                                                                                                                                     |
| Shard size            | `ceil(fileSize / dataShards)` — with 2 data shards a 100 MB file produces two 50 MB shards + one 50 MB parity shard                                                                                             |
| Max body (production) | **120 MB** — set via Traefik buffering middleware (`maxRequestBodyBytes = 125,829,120`)                                                                                                                          |
| File sharing          | Shadow copies stored decrypted on server for up to 7 days                                                                                                                                                       |
| App signing           | Not configured — macOS/Windows will show security warnings on first launch (acceptable for beta)                                                                                                                |
| App icons             | `assets/icon.ico` (Windows) is present. macOS builds need `assets/icon.icns`; Linux builds need `assets/icon.png` (256×256 min); the tray needs `assets/tray-icon.png` (16×16) — falls back to empty if missing |

---

## License

Private — all rights reserved. Contact the project owner before forking or redistributing.
