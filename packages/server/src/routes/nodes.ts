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

  // GET /api/v1/nodes/online-count — how many nodes are currently online
  fastify.get("/online-count", async (_request, reply) => {
    const threshold = new Date(Date.now() - NODE_OFFLINE_THRESHOLD_MS);
    const count = await prisma.storageNode.count({
      where: { status: "online", lastSeenAt: { gte: threshold } },
    });
    return reply.send({ count });
  });

  // GET /api/v1/nodes/swarm-stats — aggregate swarm statistics (public, no auth)
  fastify.get("/swarm-stats", async (_request, reply) => {
    const threshold = new Date(Date.now() - NODE_OFFLINE_THRESHOLD_MS);
    const [onlineAgg, totalAgg] = await Promise.all([
      prisma.storageNode.aggregate({
        where: { status: "online", lastSeenAt: { gte: threshold } },
        _count: { id: true },
        _sum: { pledgedBytes: true, usedBytes: true },
      }),
      prisma.storageNode.aggregate({
        _count: { id: true },
        _sum: { pledgedBytes: true },
      }),
    ]);
    return reply.send({
      onlineNodes: onlineAgg._count.id,
      totalNodes: totalAgg._count.id,
      onlinePledgedBytes: Number(onlineAgg._sum.pledgedBytes ?? 0),
      totalPledgedBytes: Number(totalAgg._sum.pledgedBytes ?? 0),
      usedBytes: Number(onlineAgg._sum.usedBytes ?? 0),
    });
  });
}
