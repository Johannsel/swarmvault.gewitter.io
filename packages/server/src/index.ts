import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCors from "@fastify/cors";
import type { WebSocket } from "@fastify/websocket";

// Make Prisma's BigInt values JSON-serializable (safe up to ~9 PB as a JS number)
(BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
  return Number(this);
};
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebSocket from "@fastify/websocket";
import { Queue, Worker } from "bullmq";
import { Redis as IORedis } from "ioredis";
import { config } from "./config.js";
import { prisma } from "./database.js";
import { authRoutes } from "./routes/auth.js";
import { nodeRoutes } from "./routes/nodes.js";
import { fileRoutes } from "./routes/files.js";
import { chunkRoutes } from "./routes/chunks.js";
import { retrievalRoutes } from "./routes/retrieval.js";
import { rewardRoutes } from "./routes/rewards.js";
import { sharingRoutes, publicShareRoutes } from "./routes/sharing.js";
import { rewardService } from "./services/rewards.js";
import { nodeService } from "./services/nodes.js";
import { distributionService } from "./services/distribution.js";
import { API_BASE } from "@swarmvault/shared";

// ─────────────────────────────────────────────
//  Redis & BullMQ
// ─────────────────────────────────────────────

const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

const rewardQueue = new Queue("rewards", { connection: redis });
const nodeHealthQueue = new Queue("node-health", { connection: redis });
const maintenanceQueue = new Queue("maintenance", { connection: redis });

// Fail fast in production if PUBLIC_URL is not configured — it is embedded in
// share URLs so omitting it allows host-header injection attacks.
if (config.NODE_ENV === "production" && !config.PUBLIC_URL) {
  console.error("❌  PUBLIC_URL must be set in production (required for share URLs).");
  process.exit(1);
}

// Reward snapshot worker
new Worker(
  "rewards",
  async () => {
    await rewardService.runSnapshot();
  },
  { connection: redis },
);

// Maintenance worker — shadow-file cleanup, trash purge, tier promotion
new Worker(
  "maintenance",
  async (job) => {
    if (job.name === "cleanup-shares") {
      const deleted = await prisma.sharedFile.deleteMany({ where: { expiresAt: { lt: new Date() } } });
      if (deleted.count > 0) console.log(`[sharing] Pruned ${deleted.count} expired shadow file(s)`);
    } else if (job.name === "purge-trash") {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const trashed = await prisma.swarmFile.findMany({ where: { deletedAt: { lt: cutoff } }, select: { id: true } });
      if (trashed.length > 0) {
        await prisma.swarmFile.deleteMany({ where: { id: { in: trashed.map((f) => f.id) } } });
        console.log(`[trash] Permanently deleted ${trashed.length} file(s) older than 30 days`);
      }
    } else if (job.name === "tier-promotion") {
      const [promoted, demoted] = await Promise.all([
        prisma.storageNode.updateMany({ where: { uptimePct: { gte: 80 }, tier: "swarm" }, data: { tier: "vault" } }),
        prisma.storageNode.updateMany({ where: { uptimePct: { lt: 80 }, tier: "vault" }, data: { tier: "swarm" } }),
      ]);
      if (promoted.count > 0 || demoted.count > 0) {
        console.log(`[tier] Promoted ${promoted.count} node(s) to vault, demoted ${demoted.count} to swarm`);
      }
    }
  },
  { connection: redis },
);

// Node health worker — marks stale nodes offline every minute, then attempts
// to distribute any files that were queued while nodes were unavailable.
new Worker(
  "node-health",
  async () => {
    const count = await nodeService.markStaleNodesOffline();
    if (count > 0) console.log(`[node-health] Marked ${count} nodes as offline`);
    const distributed = await distributionService.tryDistributePendingFiles(redis);
    if (distributed > 0) console.log(`[node-health] Assigned ${distributed} queued file(s)`);
  },
  { connection: redis },
);

// Schedule recurring jobs (idempotent — repeatable jobs are de-duped by key)
await rewardQueue.add("snapshot", {}, { repeat: { pattern: config.REWARD_CRON }, jobId: "reward-snapshot" });
await nodeHealthQueue.add("check", {}, { repeat: { every: 60_000 }, jobId: "node-health-check" });
await maintenanceQueue.add("cleanup-shares", {}, { repeat: { every: 60 * 60 * 1000 }, jobId: "maintenance-cleanup-shares" });
await maintenanceQueue.add("purge-trash", {}, { repeat: { every: 60 * 60 * 1000 }, jobId: "maintenance-purge-trash" });
await maintenanceQueue.add("tier-promotion", {}, { repeat: { every: 60 * 60 * 1000 }, jobId: "maintenance-tier-promotion" });

// ─────────────────────────────────────────────
//  Fastify app
// ─────────────────────────────────────────────

const fastify = Fastify({
  logger: {
    level: config.NODE_ENV === "development" ? "debug" : "info",
  },
  trustProxy: true, // Required behind Traefik: enables correct X-Forwarded-For / client IP resolution
});

// Augment FastifyInstance with `authenticate` decorator
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: import("fastify").FastifyRequest, reply: import("fastify").FastifyReply) => Promise<void>;
    redis: IORedis;
    /** Active WebSocket connections keyed by nodeId */
    nodeConnections: Map<string, WebSocket>;
    /** Pending chunk-ack callbacks keyed by "fileId:shardIndex" */
    pendingAcks: Map<string, (ok: boolean) => void>;
    /** Pending chunk-response callbacks keyed by "fileId:shardIndex" (retrieval) */
    pendingChunkResponses: Map<string, (data: Buffer | null) => void>;
  }
}

await fastify.register(fastifyCors, {
  origin: config.NODE_ENV === "development" ? true : ["https://swarmvault.gewitter.io"],
  credentials: true,
});

await fastify.register(fastifyRateLimit, {
  max: 200,
  timeWindow: "1 minute",
});

await fastify.register(fastifyJwt, {
  secret: config.JWT_SECRET,
  sign: { expiresIn: config.JWT_EXPIRY },
});

await fastify.register(fastifyWebSocket);

// Expose jwtVerify as a named decorator for preHandlers
fastify.decorate("authenticate", async function (request, reply) {
  try {
    await request.jwtVerify();
  } catch {
    await reply.status(401).send({ error: "Unauthorized" });
  }
});

// Expose the shared Redis client so routes can use the pending-distribution cache
fastify.decorate("redis", redis);

// Shared state for the WebSocket relay layer
const nodeConnections = new Map<string, WebSocket>();
const pendingAcks = new Map<string, (ok: boolean) => void>();
const pendingChunkResponses = new Map<string, (data: Buffer | null) => void>();
fastify.decorate("nodeConnections", nodeConnections);
fastify.decorate("pendingAcks", pendingAcks);
fastify.decorate("pendingChunkResponses", pendingChunkResponses);

// ─────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────

await fastify.register(authRoutes, { prefix: `${API_BASE}/auth` });
await fastify.register(nodeRoutes, { prefix: `${API_BASE}/nodes` });
await fastify.register(fileRoutes, { prefix: `${API_BASE}/files` });
// 110 MB — enough headroom above the 100 MB file cap (1 data shard = file size + 28-byte encryption overhead).
// All other routes keep Fastify's default 1 MB limit so oversized JSON payloads are still rejected.
await fastify.register(chunkRoutes, { prefix: `${API_BASE}/chunks`, bodyLimit: 115 * 1024 * 1024 });
await fastify.register(retrievalRoutes, { prefix: `${API_BASE}/files` });
await fastify.register(rewardRoutes, { prefix: `${API_BASE}/rewards` });
await fastify.register(sharingRoutes, { prefix: `${API_BASE}/files` });
await fastify.register(publicShareRoutes, { prefix: `${API_BASE}/share` });

// Health check
fastify.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

// ─────────────────────────────────────────────
//  Redistribution helper
// ─────────────────────────────────────────────

/**
 * When a node reduces its pledged quota below its current usedBytes, move
 * enough chunks to other nodes so the node no longer exceeds its capacity.
 * Operates over the existing chunk-relay WS infrastructure.
 */
async function redistributeOverCapacityChunks(sourceNodeId: string, app: typeof fastify): Promise<void> {
  const sourceNode = await prisma.storageNode.findUnique({
    where: { id: sourceNodeId },
    select: { pledgedBytes: true, usedBytes: true, relayToken: true },
  });
  if (!sourceNode) return;

  const overageBytes = sourceNode.usedBytes - sourceNode.pledgedBytes;
  if (overageBytes <= BigInt(0)) return;

  // Find chunks stored on this node, largest first, until we've covered the overage
  const locations = await prisma.chunkLocation.findMany({
    where: { nodeId: sourceNodeId },
    include: { chunk: true },
    orderBy: { chunk: { sizeBytes: "desc" } },
  });

  let bytesToFree = overageBytes;
  const toRelocate: typeof locations = [];
  for (const loc of locations) {
    if (bytesToFree <= BigInt(0)) break;
    toRelocate.push(loc);
    bytesToFree -= BigInt(loc.chunk.sizeBytes);
  }

  if (toRelocate.length === 0) return;

  const sourceSocket = app.nodeConnections.get(sourceNodeId);
  const { randomBytes } = await import("node:crypto");

  for (const loc of toRelocate) {
    const { chunk } = loc;

    // 1. Find a replacement node (online, has capacity, not the source)
    const threshold = new Date(Date.now() - 5 * 60 * 1000); // online within 5 min
    const target = await prisma.storageNode.findFirst({
      where: {
        id: { not: sourceNodeId },
        status: "online",
        lastSeenAt: { gte: threshold },
        usedBytes: { lt: prisma.storageNode.fields.pledgedBytes },
      },
      orderBy: { usedBytes: "asc" },
      select: { id: true, relayToken: true },
    });
    if (!target) {
      app.log.warn(`No available target node for redistribution of chunk ${chunk.id}`);
      break;
    }

    const targetSocket = app.nodeConnections.get(target.id);
    if (!targetSocket || targetSocket.readyState !== 1) {
      app.log.warn(`Target node ${target.id} WS not open, skipping chunk ${chunk.id}`);
      continue;
    }

    if (!sourceSocket || sourceSocket.readyState !== 1) {
      app.log.warn(`Source node ${sourceNodeId} WS disconnected during redistribution`);
      break;
    }

    // 2. Request chunk data from source node
    const requestNonce = randomBytes(8).toString("hex");
    const requestKey = `${chunk.fileId}:${chunk.shardIndex}:${requestNonce}`;
    const TIMEOUT_MS = 60_000;

    const chunkData = await new Promise<Buffer | null>((resolve) => {
      const timer = setTimeout(() => {
        app.pendingChunkResponses.delete(requestKey);
        resolve(null);
      }, TIMEOUT_MS);
      app.pendingChunkResponses.set(requestKey, (data) => {
        clearTimeout(timer);
        app.pendingChunkResponses.delete(requestKey);
        resolve(data);
      });
      sourceSocket.send(
        JSON.stringify({
          type: "chunk_request",
          payload: { fileId: chunk.fileId, shardIndex: chunk.shardIndex, requestNonce },
        }),
      );
    });

    if (!chunkData) {
      app.log.warn(`Source node ${sourceNodeId} did not respond with chunk ${chunk.id} within timeout`);
      continue;
    }

    // 3. Relay chunk data to target node and wait for ack
    const ackNonce = randomBytes(8).toString("hex");
    const ackKey = `${chunk.fileId}:${chunk.shardIndex}:${ackNonce}`;

    const acked = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        app.pendingAcks.delete(ackKey);
        resolve(false);
      }, TIMEOUT_MS);
      app.pendingAcks.set(ackKey, (ok) => {
        clearTimeout(timer);
        app.pendingAcks.delete(ackKey);
        resolve(ok);
      });
      targetSocket.send(
        JSON.stringify({
          type: "chunk_relay",
          payload: {
            fileId: chunk.fileId,
            shardIndex: chunk.shardIndex,
            chunkHash: chunk.chunkHash,
            isData: chunk.isData,
            ackNonce,
            data: chunkData.toString("base64"),
          },
        }),
      );
    });

    if (!acked) {
      app.log.warn(`Target node ${target.id} did not ack chunk ${chunk.id} during redistribution`);
      continue;
    }

    // 4. Update DB: add new location, remove old, update node usedBytes
    await prisma.$transaction([
      prisma.chunkLocation.upsert({
        where: { chunkId_nodeId: { chunkId: chunk.id, nodeId: target.id } },
        create: { chunkId: chunk.id, nodeId: target.id, verified: true },
        update: { verified: true, storedAt: new Date() },
      }),
      prisma.chunkLocation.delete({
        where: { chunkId_nodeId: { chunkId: chunk.id, nodeId: sourceNodeId } },
      }),
      prisma.storageNode.update({
        where: { id: sourceNodeId },
        data: { usedBytes: { decrement: BigInt(chunk.sizeBytes) } },
      }),
      prisma.storageNode.update({
        where: { id: target.id },
        data: { usedBytes: { increment: BigInt(chunk.sizeBytes) } },
      }),
    ]);

    // 5. Tell source node to delete its copy
    if (sourceSocket.readyState === 1) {
      sourceSocket.send(
        JSON.stringify({
          type: "chunk_delete",
          payload: { fileId: chunk.fileId, shardIndex: chunk.shardIndex },
        }),
      );
    }

    app.log.info(`Redistributed chunk ${chunk.id} from node ${sourceNodeId} → ${target.id}`);
  }
}

// ─────────────────────────────────────────────
//  WebSocket — desktop client persistent connection
// ─────────────────────────────────────────────

fastify.get("/ws", { websocket: true }, (socket, _request) => {
  let authenticatedNodeId: string | null = null;

  socket.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        payload: Record<string, unknown>;
      };

      // ── Node authentication ─────────────────────────────────────────────
      if (msg.type === "auth") {
        const { nodeId, relayToken } = msg.payload as { nodeId: string; relayToken: string };
        const node = await prisma.storageNode.findFirst({ where: { id: nodeId, relayToken } });
        if (!node) {
          socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid credentials" } }));
          // Close with 4001 so the client can detect stale node credentials and re-register
          socket.close(4001, "Invalid credentials");
          return;
        }
        authenticatedNodeId = nodeId;
        nodeConnections.set(nodeId, socket);
        socket.send(JSON.stringify({ type: "auth_ack", payload: { nodeId } }));
        fastify.log.info(`Node ${nodeId} authenticated via WebSocket`);
        return;
      }

      // Reject all non-auth messages from unauthenticated connections
      if (!authenticatedNodeId) {
        socket.send(JSON.stringify({ type: "error", payload: { message: "Not authenticated" } }));
        return;
      }

      // ── Chunk acknowledgement from node (upload path) ──────────────────
      if (msg.type === "chunk_ack") {
        const { fileId, shardIndex, ackNonce, success } = msg.payload as {
          fileId: string;
          shardIndex: number;
          ackNonce: string;
          success: boolean;
        };
        // Key includes the nonce so only the relay recipient can resolve the ack
        const key = `${fileId}:${shardIndex}:${ackNonce}`;
        const resolve = pendingAcks.get(key);
        if (resolve) resolve(success as boolean);
        return;
      }

      // ── Chunk response from node (download / retrieval path) ─────────────
      if (msg.type === "chunk_response") {
        const { fileId, shardIndex, requestNonce, data } = msg.payload as {
          fileId: string;
          shardIndex: number;
          requestNonce: string;
          data: string | null;
        };
        const key = `${fileId}:${shardIndex}:${requestNonce}`;
        const resolve = pendingChunkResponses.get(key);
        if (resolve) resolve(data ? Buffer.from(data, "base64") : null);
        return;
      }

      // ── Heartbeat (legacy WS path — HTTP POST /heartbeat is preferred) ──
      if (msg.type === "heartbeat") {
        const { nodeId, relayToken, status, usedBytes, pledgedBytes } = msg.payload as {
          nodeId: string;
          relayToken: string;
          status: string;
          usedBytes: number;
          pledgedBytes: number;
        };

        // Reject heartbeats for a different node — prevents a malicious node from
        // keeping another node alive (and gaming the reward/uptime system).
        if (nodeId !== authenticatedNodeId) {
          socket.send(JSON.stringify({ type: "error", payload: { message: "nodeId does not match authenticated connection" } }));
          return;
        }

        const node = await prisma.storageNode.findFirst({
          where: { id: nodeId, relayToken },
        });

        if (!node) {
          socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid node credentials" } }));
          return;
        }

        const previousPledgedBytes = node.pledgedBytes;

        await prisma.storageNode.update({
          where: { id: node.id },
          data: {
            status: status as "online" | "offline" | "maintenance",
            usedBytes,
            pledgedBytes,
            lastSeenAt: new Date(),
          },
        });

        // If quota was reduced and the node is now over capacity, kick off background
        // redistribution so chunks are moved to other nodes rather than deleted.
        if (pledgedBytes < previousPledgedBytes && usedBytes > pledgedBytes) {
          fastify.log.info(`Node ${nodeId} reduced quota (${previousPledgedBytes} → ${pledgedBytes}, used ${usedBytes}) — queuing redistribution`);
          redistributeOverCapacityChunks(nodeId, fastify).catch((e: unknown) => {
            fastify.log.error(e, `Redistribution failed for node ${nodeId}`);
          });
        }

        await nodeService.checkPendingRetrievalJobs(node.id);
        socket.send(JSON.stringify({ type: "heartbeat_ack", payload: { ts: Date.now() } }));
      }
    } catch (err) {
      fastify.log.error(err, "WebSocket message error");
    }
  });

  socket.on("close", () => {
    if (authenticatedNodeId) {
      nodeConnections.delete(authenticatedNodeId);
      fastify.log.info(`Node ${authenticatedNodeId} WebSocket disconnected`);
    }
  });
});

// ─────────────────────────────────────────────
//  Start
// ─────────────────────────────────────────────

const gracefulShutdown = async (signal: string) => {
  fastify.log.info(`Received ${signal}, shutting down gracefully…`);
  await fastify.close();
  await prisma.$disconnect();
  await redis.quit();
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

try {
  await fastify.listen({ port: config.PORT, host: config.HOST });
  console.log(`SwarmVault server listening on http://${config.HOST}:${config.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
