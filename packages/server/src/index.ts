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
import IORedis from "ioredis";
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

// Reward snapshot worker
new Worker(
  "rewards",
  async () => {
    await rewardService.runSnapshot();
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

// ─────────────────────────────────────────────
//  Fastify app
// ─────────────────────────────────────────────

const fastify = Fastify({
  logger: {
    level: config.NODE_ENV === "development" ? "debug" : "info",
  },
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
await fastify.register(chunkRoutes, { prefix: `${API_BASE}/chunks` });
await fastify.register(retrievalRoutes, { prefix: `${API_BASE}/files` });
await fastify.register(rewardRoutes, { prefix: `${API_BASE}/rewards` });
await fastify.register(sharingRoutes, { prefix: `${API_BASE}/files` });
await fastify.register(publicShareRoutes, { prefix: `${API_BASE}/share` });

// Expired shadow-file cleanup — runs every hour
setInterval(
  async () => {
    const deleted = await prisma.sharedFile.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    if (deleted.count > 0) fastify.log.info(`[sharing] Pruned ${deleted.count} expired shadow file(s)`);
  },
  60 * 60 * 1000,
);

// 30-day trash purge — hard-deletes files that have been in trash longer than 30 days
setInterval(
  async () => {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const trashed = await prisma.swarmFile.findMany({
      where: { deletedAt: { lt: cutoff } },
      select: { id: true },
    });
    if (trashed.length > 0) {
      await prisma.swarmFile.deleteMany({ where: { id: { in: trashed.map((f) => f.id) } } });
      fastify.log.info(`[trash] Permanently deleted ${trashed.length} file(s) older than 30 days`);
    }
  },
  60 * 60 * 1000,
);

// Tier auto-promotion — every hour, promote nodes with ≥80% uptime to vault and
// demote nodes below 80% back to swarm. No manual tier selection needed.
setInterval(
  async () => {
    const [promoted, demoted] = await Promise.all([
      prisma.storageNode.updateMany({
        where: { uptimePct: { gte: 80 }, tier: "swarm" },
        data: { tier: "vault" },
      }),
      prisma.storageNode.updateMany({
        where: { uptimePct: { lt: 80 }, tier: "vault" },
        data: { tier: "swarm" },
      }),
    ]);
    if (promoted.count > 0 || demoted.count > 0) {
      fastify.log.info(`[tier] Promoted ${promoted.count} node(s) to vault, demoted ${demoted.count} to swarm`);
    }
  },
  60 * 60 * 1000,
);

// Health check
fastify.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

// ─────────────────────────────────────────────
//  WebSocket — desktop client persistent connection
// ─────────────────────────────────────────────

fastify.get("/ws", { websocket: true }, (socket, _request) => {
  let authenticatedNodeId: string | null = null;

  socket.on("message", async (raw) => {
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
        const { fileId, shardIndex, success } = msg.payload as {
          fileId: string;
          shardIndex: number;
          success: boolean;
        };
        const key = `${fileId}:${shardIndex}`;
        const resolve = pendingAcks.get(key);
        if (resolve) resolve(success as boolean);
        return;
      }

      // ── Chunk response from node (download / retrieval path) ─────────────
      if (msg.type === "chunk_response") {
        const { fileId, shardIndex, data } = msg.payload as {
          fileId: string;
          shardIndex: number;
          data: string | null;
        };
        const key = `${fileId}:${shardIndex}`;
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

        const node = await prisma.storageNode.findFirst({
          where: { id: nodeId, relayToken },
        });

        if (!node) {
          socket.send(JSON.stringify({ type: "error", payload: { message: "Invalid node credentials" } }));
          return;
        }

        await prisma.storageNode.update({
          where: { id: node.id },
          data: {
            status: status as "online" | "offline" | "maintenance",
            usedBytes,
            pledgedBytes,
            lastSeenAt: new Date(),
          },
        });

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
