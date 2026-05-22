import type { Redis } from "ioredis";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "../database.js";
import { distributionService } from "../services/distribution.js";
import { NODE_OFFLINE_THRESHOLD_MS } from "@swarmvault/shared";

const registerNodeBody = z.object({
  displayName: z.string().min(1).max(64),
  tier: z.enum(["vault", "swarm"]),
  pledgedBytes: z.number().int().positive(),
});

const heartbeatBody = z.object({
  nodeId: z.string(),
  status: z.enum(["online", "offline", "maintenance"]),
  usedBytes: z.number().int().min(0),
  pledgedBytes: z.number().int().positive(),
  availableDiskBytes: z.number().int().min(0).optional(),
});

export async function nodeRoutes(fastify: FastifyInstance & { redis: Redis }): Promise<void> {
  const preHandler = [fastify.authenticate];

  // POST /api/v1/nodes — register a new storage node
  fastify.post("/", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const body = registerNodeBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Validation failed", details: body.error.flatten() });
    }

    const { displayName, tier, pledgedBytes } = body.data;
    const relayToken = randomBytes(32).toString("hex");

    const node = await prisma.storageNode.create({
      data: {
        userId: payload.sub,
        displayName,
        tier,
        pledgedBytes,
        relayToken,
        status: "offline",
      },
    });

    return reply.status(201).send({ node: { ...node, relayToken } });
  });

  // GET /api/v1/nodes — list caller's nodes
  fastify.get("/", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const nodes = await prisma.storageNode.findMany({
      where: { userId: payload.sub },
      select: {
        id: true,
        displayName: true,
        tier: true,
        status: true,
        pledgedBytes: true,
        usedBytes: true,
        lastSeenAt: true,
        registeredAt: true,
        uptimePct: true,
        uptimePct3m: true,
      },
    });
    return reply.send({ nodes });
  });

  // DELETE /api/v1/nodes/:id — unregister a node
  fastify.delete("/:id", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id } = request.params as { id: string };

    const node = await prisma.storageNode.findFirst({
      where: { id, userId: payload.sub },
    });
    if (!node) return reply.status(404).send({ error: "Node not found" });

    await prisma.storageNode.delete({ where: { id } });
    return reply.status(204).send();
  });

  // POST /api/v1/nodes/heartbeat — called by desktop client every ~30 s
  fastify.post("/heartbeat", async (request, reply) => {
    const body = heartbeatBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Validation failed" });
    }

    // Authenticate via relay token in Authorization header
    const authHeader = request.headers.authorization;
    const relayToken = authHeader?.replace(/^Bearer\s+/i, "");
    if (!relayToken) return reply.status(401).send({ error: "Missing relay token" });

    const node = await prisma.storageNode.findFirst({
      where: { id: body.data.nodeId, relayToken },
    });
    if (!node) return reply.status(401).send({ error: "Invalid relay token" });

    const wasOffline = node.status !== "online";

    await prisma.storageNode.update({
      where: { id: node.id },
      data: {
        status: body.data.status,
        usedBytes: body.data.usedBytes,
        pledgedBytes: body.data.pledgedBytes,
        availableDiskBytes: body.data.availableDiskBytes != null ? BigInt(body.data.availableDiskBytes) : undefined,
        lastSeenAt: new Date(),
      },
    });

    // When a node transitions from offline → online, kick the pending-distribution
    // worker asynchronously so queued files get assigned as quickly as possible.
    if (wasOffline && body.data.status === "online") {
      distributionService.tryDistributePendingFiles(fastify.redis).catch((err) => console.error("[heartbeat] tryDistributePendingFiles failed:", err));
    }

    return reply.send({ ok: true });
  });

  // GET /api/v1/nodes/online-count — how many nodes are currently online
  fastify.get("/online-count", async (_request, reply) => {
    const threshold = new Date(Date.now() - NODE_OFFLINE_THRESHOLD_MS);
    const count = await prisma.storageNode.count({
      where: { status: "online", lastSeenAt: { gte: threshold } },
    });
    return reply.send({ count });
  });
}
