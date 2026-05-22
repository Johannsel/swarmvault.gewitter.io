import type { Redis } from "ioredis";
import { prisma } from "../database.js";
import { NODE_OFFLINE_THRESHOLD_MS } from "@swarmvault/shared";

// ─── Redis keys ────────────────────────────────────────────────────────────────
const PENDING_QUEUE_KEY = "swarmvault:pending-distribution";
const assignmentKey = (fileId: string) => `swarmvault:assignment:${fileId}`;
/** How long (seconds) a cached assignment lives — long enough for the client to start uploading. */
const ASSIGNMENT_TTL_S = 3600; // 1 hour

interface ShardAssignment {
  shardIndex: number;
  nodeId: string;
  nodeRelayToken: string;
}

export const distributionService = {
  /**
   * Select `shardCount` distinct online nodes to receive shards from a unified pool.
   *
   * Strategy — vault-first, then swarm fill:
   *  - Vault-tier nodes (uptime ≥ 80%) are preferred for the first data shards
   *    so at least one durable copy always exists.
   *  - If vault nodes alone can't fill all slots, swarm nodes fill the remainder.
   *  - Within each tier, nodes are ordered by least-used storage.
   *
   * Tier is no longer a per-file property chosen by the user; it is automatically
   * derived from each node's measured uptime.
   */
  async assignNodes(
    fileId: string,
    shardCount: number
  ): Promise<ShardAssignment[]> {
    const threshold = new Date(Date.now() - NODE_OFFLINE_THRESHOLD_MS);

    // 500 MB safety buffer — skip nodes that are almost out of disk space
    const MIN_DISK_BUFFER = BigInt(500 * 1024 * 1024);

    const baseWhere = {
      status: "online" as const,
      lastSeenAt: { gte: threshold },
      usedBytes: { lt: prisma.storageNode.fields.pledgedBytes },
      // Allow nodes that haven't reported availableDiskBytes yet (null = unknown = ok)
      OR: [
        { availableDiskBytes: null },
        { availableDiskBytes: { gt: MIN_DISK_BUFFER } },
      ],
    };

    // Fetch vault and swarm nodes separately so we can interleave vault-first
    const [vaultNodes, swarmNodes] = await Promise.all([
      prisma.storageNode.findMany({
        where: { ...baseWhere, tier: "vault" },
        orderBy: { usedBytes: "asc" },
        take: shardCount,
        select: { id: true, relayToken: true },
      }),
      prisma.storageNode.findMany({
        where: { ...baseWhere, tier: "swarm" },
        orderBy: { usedBytes: "asc" },
        take: shardCount,
        select: { id: true, relayToken: true },
      }),
    ]);

    // Build a combined candidate list: vault nodes first, then swarm fill
    const candidates = [...vaultNodes, ...swarmNodes];

    if (candidates.length < shardCount) {
      throw new Error(
        `Not enough online nodes (need ${shardCount}, have ${candidates.length})`
      );
    }

    const assignments: ShardAssignment[] = [];
    for (let i = 0; i < shardCount; i++) {
      const node = candidates[i % candidates.length]!;
      assignments.push({
        shardIndex: i,
        nodeId: node.id,
        nodeRelayToken: node.relayToken ?? "",
      });
    }

    return assignments;
  },

  /**
   * Record that a chunk has been stored on a node.
   */
  async recordChunkStored(params: {
    fileId: string;
    shardIndex: number;
    isData: boolean;
    sizeBytes: number;
    chunkHash: string;
    nodeId: string;
  }): Promise<void> {
    const { fileId, shardIndex, isData, sizeBytes, chunkHash, nodeId } = params;

    const chunk = await prisma.fileChunk.upsert({
      where: { fileId_shardIndex: { fileId, shardIndex } },
      create: { fileId, shardIndex, isData, sizeBytes, chunkHash },
      update: { chunkHash },
    });

    await prisma.chunkLocation.upsert({
      where: { chunkId_nodeId: { chunkId: chunk.id, nodeId } },
      create: { chunkId: chunk.id, nodeId, verified: true },
      update: { verified: true, storedAt: new Date() },
    });

    // Update node usedBytes
    await prisma.storageNode.update({
      where: { id: nodeId },
      data: { usedBytes: { increment: BigInt(sizeBytes) } },
    });

    // Check if all shards for the file are now stored
    await distributionService.updateFileStatus(fileId);
  },

  /**
   * Transition file status to 'available' once all shards are stored,
   * or 'degraded' if some are missing.
   */
  async updateFileStatus(fileId: string): Promise<void> {
    const file = await prisma.swarmFile.findUnique({
      where: { id: fileId },
      include: { chunks: { include: { locations: true } } },
    });
    if (!file || file.status === "deleted") return;

    const totalExpected = file.totalShards + file.parityShards;
    const storedShards = file.chunks.filter((c) => c.locations.length > 0).length;

    let newStatus: "available" | "degraded" | "pending" = "pending";
    if (storedShards >= file.totalShards) {
      newStatus = "available";
    } else if (storedShards > 0) {
      newStatus = "degraded";
    }

    if (newStatus !== file.status) {
      await prisma.swarmFile.update({
        where: { id: fileId },
        data: {
          status: newStatus,
          ...(newStatus === "available"
            ? {
                owner: {
                  update: { usedStorageBytes: { increment: file.sizeBytes } },
                },
              }
            : {}),
        },
      });
    }
  },

  // ─── Pending-distribution cache ─────────────────────────────────────────────

  /** Enqueue a file that couldn't be assigned immediately (not enough online nodes). */
  async queuePendingFile(redis: Redis, fileId: string): Promise<void> {
    await redis.sadd(PENDING_QUEUE_KEY, fileId);
  },

  /** Return a previously computed and cached shard assignment, or null if none. */
  async getCachedAssignment(redis: Redis, fileId: string): Promise<ShardAssignment[] | null> {
    const raw = await redis.get(assignmentKey(fileId));
    if (!raw) return null;
    return JSON.parse(raw) as ShardAssignment[];
  },

  /**
   * Iterate every file in the pending queue and attempt a shard assignment for
   * each one.  Successfully assigned files are removed from the queue and their
   * assignment is cached in Redis so the client can retrieve it by polling
   * GET /api/v1/files/:id/assignment.
   *
   * Returns the number of files that were successfully assigned.
   */
  async tryDistributePendingFiles(redis: Redis): Promise<number> {
    const fileIds = await redis.smembers(PENDING_QUEUE_KEY);
    if (fileIds.length === 0) return 0;

    let assigned = 0;
    for (const fileId of fileIds) {
      const file = await prisma.swarmFile.findUnique({
        where: { id: fileId },
        select: { id: true, status: true, tier: true, totalShards: true, parityShards: true },
      });

      // Remove stale queue entries (file deleted or no longer pending)
      if (!file || file.status !== "pending") {
        await redis.srem(PENDING_QUEUE_KEY, fileId);
        continue;
      }

      const totalShards = file.totalShards + file.parityShards;
      try {
        const assignment = await distributionService.assignNodes(
          fileId,
          totalShards
        );
        // Cache the assignment and remove from the queue
        await redis.set(assignmentKey(fileId), JSON.stringify(assignment), "EX", ASSIGNMENT_TTL_S);
        await redis.srem(PENDING_QUEUE_KEY, fileId);
        assigned++;
        console.log(`[distribution] Queued file ${fileId} now has a shard assignment`);
      } catch {
        // Not enough nodes yet — leave in the queue and try again next cycle
      }
    }

    return assigned;
  },
};
