import { prisma } from "../database.js";
import { NODE_OFFLINE_THRESHOLD_MS } from "@swarmvault/shared";

/**
 * Background job: mark nodes as offline if they haven't sent a heartbeat recently.
 * Should run every minute.
 */
export const nodeService = {
  async markStaleNodesOffline(): Promise<number> {
    const threshold = new Date(Date.now() - NODE_OFFLINE_THRESHOLD_MS);
    const result = await prisma.storageNode.updateMany({
      where: {
        status: "online",
        lastSeenAt: { lt: threshold },
      },
      data: { status: "offline" },
    });
    return result.count;
  },

  /**
   * After a node comes back online, check if any retrieval jobs were waiting for it
   * and re-queue them.
   */
  async checkPendingRetrievalJobs(nodeId: string): Promise<void> {
    // Find files whose chunks are on this node and have waiting retrieval jobs
    const jobs = await prisma.retrievalJob.findMany({
      where: {
        status: "waiting_nodes",
        file: {
          chunks: {
            some: {
              locations: { some: { nodeId } },
            },
          },
        },
      },
      select: { id: true },
    });

    if (jobs.length > 0) {
      await prisma.retrievalJob.updateMany({
        where: { id: { in: jobs.map((j) => j.id) } },
        data: { status: "queued" },
      });
    }
  },
};
