import { FastifyInstance } from "fastify";
import { prisma } from "../database.js";
import { BYTES_PER_CREDIT } from "@swarmvault/shared";

export async function rewardRoutes(fastify: FastifyInstance): Promise<void> {
  const preHandler = [fastify.authenticate];

  // GET /api/v1/rewards — current balance + recent snapshots
  fastify.get("/", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };

    const [balance, snapshots, user] = await Promise.all([
      prisma.rewardBalance.findUnique({ where: { userId: payload.sub } }),
      prisma.contributionSnapshot.findMany({
        where: { userId: payload.sub },
        orderBy: { snapshotAt: "desc" },
        take: 48, // last 48 hourly snapshots
      }),
      prisma.user.findUnique({
        where: { id: payload.sub },
        select: { storageQuotaBytes: true, usedStorageBytes: true },
      }),
    ]);

    return reply.send({
      balance,
      recentSnapshots: snapshots,
      quota: user,
      creditsToBytes: BYTES_PER_CREDIT,
    });
  });

  // GET /api/v1/rewards/leaderboard — top contributors (public)
  fastify.get("/leaderboard", async (_request, reply) => {
    const top = await prisma.rewardBalance.findMany({
      orderBy: { lifetimeEarned: "desc" },
      take: 25,
      include: {
        user: { select: { username: true } },
      },
    });

    const entries = top.map((r) => ({
      username: r.user.username,
      lifetimeCredits: r.lifetimeEarned,
    }));

    return reply.send({ leaderboard: entries });
  });
}
