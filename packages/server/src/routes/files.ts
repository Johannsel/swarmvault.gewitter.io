import type { Redis } from "ioredis";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../database.js";
import { distributionService } from "../services/distribution.js";

const createFileBody = z.object({
  name: z.string().min(1).max(255),
  path: z.string().min(1),
  mimeType: z.string().default("application/octet-stream"),
  sizeBytes: z.number().int().positive(),
  // Tier is no longer client-chosen — it is auto-assigned based on node uptimes.
  // Accepted for backward-compatibility but ignored on the server.
  tier: z.enum(["vault", "swarm"]).optional(),
  contentHash: z.string().length(64), // hex SHA-256
  totalShards: z.number().int().positive(),
  parityShards: z.number().int().min(1),
  /** Encrypted per-shard master key (base64url), stored encrypted server-side */
  encryptedMasterKey: z.string(),
});

const claimFileBody = z.object({
  shutdownAfterDownload: z.boolean().default(false),
});

export async function fileRoutes(
  fastify: FastifyInstance & { redis: Redis }
): Promise<void> {
  const preHandler = [fastify.authenticate];

  // POST /api/v1/files — register a new file upload intent
  // The client has already split + encrypted the shards locally.
  // This endpoint registers the file metadata; shard uploads happen via WebSocket.
  fastify.post("/", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const body = createFileBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Validation failed", details: body.error.flatten() });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return reply.status(404).send({ error: "User not found" });

    // Check quota — being over quota blocks NEW uploads but never deletes existing files.
    // Existing files stay accessible at all times.
    const projectedUsage = BigInt(user.usedStorageBytes) + BigInt(body.data.sizeBytes);
    if (projectedUsage > BigInt(user.storageQuotaBytes)) {
      const alreadyOver = BigInt(user.usedStorageBytes) >= BigInt(user.storageQuotaBytes);
      return reply.status(402).send({
        error: "Storage quota exceeded",
        overQuota: true,
        usedBytes: Number(user.usedStorageBytes),
        quotaBytes: Number(user.storageQuotaBytes),
        message: alreadyOver
          ? "Your storage quota has been reached. Your existing files are safe — contribute storage or wait for credits to accumulate to unlock new uploads."
          : "This file would exceed your storage quota.",
      });
    }

    const totalShards = body.data.totalShards + body.data.parityShards;

    const file = await prisma.swarmFile.create({
      data: {
        ownerId: payload.sub,
        name: body.data.name,
        path: body.data.path,
        mimeType: body.data.mimeType,
        sizeBytes: body.data.sizeBytes,
        // tier is auto-assigned by the server based on node uptimes
        contentHash: body.data.contentHash,
        totalShards: body.data.totalShards,
        parityShards: body.data.parityShards,
        encryptedMasterKey: body.data.encryptedMasterKey,
        status: "pending",
      },
    });

    // Try to assign nodes immediately.
    // If there aren't enough online nodes yet, queue the file and return 202 —
    // the client should poll GET /files/:id/assignment until it gets a result.
    try {
      const assignment = await distributionService.assignNodes(
        file.id,
        totalShards
      );
      // Cache so the polling endpoint can serve it without re-querying nodes
      await fastify.redis.set(
        `swarmvault:assignment:${file.id}`,
        JSON.stringify(assignment),
        "EX",
        3600
      );
      return reply.status(201).send({ file, shardAssignment: assignment, queued: false });
    } catch {
      // Not enough online nodes — park the file in the pending queue
      await distributionService.queuePendingFile(fastify.redis, file.id);
      return reply.status(202).send({
        file,
        shardAssignment: null,
        queued: true,
        message: "Not enough online nodes right now. Poll GET /files/:id/assignment to retrieve the assignment once nodes are available.",
      });
    }
  });

  // GET /api/v1/files/manifest — lightweight list for client-side reconcile
  // Returns id, path, contentHash, sizeBytes, mimeType, tier, status, updatedAt for every
  // non-deleted file the caller owns.  Clients compare this against their local sync
  // folder to decide what to download/upload.
  fastify.get("/manifest", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const files = await prisma.swarmFile.findMany({
      where: { ownerId: payload.sub, status: { not: "deleted" }, deletedAt: null },
      select: {
        id: true,
        path: true,
        name: true,
        contentHash: true,
        sizeBytes: true,
        mimeType: true,
        tier: true,
        status: true,
        updatedAt: true,
      },
    });
    return reply.send({ files });
  });

  // GET /api/v1/files — list user's files
  fastify.get("/", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const query = z
      .object({
        path: z.string().optional(),
        status: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);

    const where: Record<string, unknown> = {
      ownerId: payload.sub,
      deletedAt: null,  // hide soft-deleted (trashed) files from the main listing
    };
    if (query.path) where["path"] = { startsWith: query.path };
    if (query.status) where["status"] = query.status;

    const [files, total, user] = await Promise.all([
      prisma.swarmFile.findMany({
        where,
        skip: query.offset,
        take: query.limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          path: true,
          mimeType: true,
          sizeBytes: true,
          status: true,
          tier: true,
          contentHash: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.swarmFile.count({ where }),
      prisma.user.findUnique({
        where: { id: payload.sub },
        select: { storageQuotaBytes: true, usedStorageBytes: true },
      }),
    ]);

    const overQuota = user
      ? BigInt(user.usedStorageBytes) > BigInt(user.storageQuotaBytes)
      : false;

    return reply.send({
      files,
      total,
      quota: {
        usedBytes: user ? Number(user.usedStorageBytes) : 0,
        quotaBytes: user ? Number(user.storageQuotaBytes) : 0,
        overQuota,
      },
    });
  });

  // PUT /api/v1/files/:id — re-upload an existing file in place
  // Preserves the file ID (and any active share), clears old chunks, then lets
  // the client re-upload new shards via the normal POST /chunks flow.
  fastify.put("/:id", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id } = request.params as { id: string };

    const body = createFileBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Validation failed", details: body.error.flatten() });
    }

    const file = await prisma.swarmFile.findFirst({ where: { id, ownerId: payload.sub } });
    if (!file) return reply.status(404).send({ error: "File not found" });

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return reply.status(404).send({ error: "User not found" });

    // Quota check: allow size-reducing updates even when over quota (user is freeing space).
    // Only block if the new version is *larger* and would push past the quota.
    const oldContribution =
      file.status === "available" || file.status === "degraded"
        ? BigInt(file.sizeBytes)
        : 0n;
    const projected =
      BigInt(user.usedStorageBytes) - oldContribution + BigInt(body.data.sizeBytes);
    const newIsSmaller = BigInt(body.data.sizeBytes) <= oldContribution;
    if (!newIsSmaller && projected > BigInt(user.storageQuotaBytes)) {
      return reply.status(402).send({
        error: "Storage quota exceeded",
        overQuota: true,
        usedBytes: Number(user.usedStorageBytes),
        quotaBytes: Number(user.storageQuotaBytes),
        message: "This update would exceed your storage quota.",
      });
    }

    // Wipe old shards (cascade clears ChunkLocations too)
    await prisma.fileChunk.deleteMany({ where: { fileId: id } });

    // Decrement old quota contribution — will be re-incremented when file becomes available
    if (oldContribution > 0n) {
      await prisma.user.update({
        where: { id: payload.sub },
        data: { usedStorageBytes: { decrement: Number(oldContribution) } },
      });
    }

    // Update metadata and reset to pending (keep same ID → shares survive)
    const updated = await prisma.swarmFile.update({
      where: { id },
      data: {
        name: body.data.name,
        path: body.data.path,
        mimeType: body.data.mimeType,
        sizeBytes: body.data.sizeBytes,
        contentHash: body.data.contentHash,
        totalShards: body.data.totalShards,
        parityShards: body.data.parityShards,
        encryptedMasterKey: body.data.encryptedMasterKey,
        status: "pending",
      },
    });

    const totalShards = body.data.totalShards + body.data.parityShards;
    try {
      const assignment = await distributionService.assignNodes(
        id,
        totalShards
      );
      await fastify.redis.set(
        `swarmvault:assignment:${id}`,
        JSON.stringify(assignment),
        "EX",
        3600
      );
      return reply.send({ file: updated, shardAssignment: assignment, queued: false });
    } catch {
      await distributionService.queuePendingFile(fastify.redis, id);
      return reply.status(202).send({ file: updated, shardAssignment: null, queued: true });
    }
  });

  // GET /api/v1/files/:id — get file details
  fastify.get("/:id", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id } = request.params as { id: string };

    const file = await prisma.swarmFile.findFirst({
      where: { id, ownerId: payload.sub },
      include: {
        chunks: {
          include: { locations: { select: { nodeId: true, verified: true } } },
        },
      },
    });

    if (!file) return reply.status(404).send({ error: "File not found" });
    return reply.send({ file });
  });

  // DELETE /api/v1/files/:id — soft-delete (move to trash, kept 30 days then auto-purged)
  fastify.delete("/:id", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id } = request.params as { id: string };

    const file = await prisma.swarmFile.findFirst({
      where: { id, ownerId: payload.sub, deletedAt: null },
    });
    if (!file) return reply.status(404).send({ error: "File not found" });

    // Soft-delete: mark as deleted, record timestamp for 30-day cleanup
    await prisma.swarmFile.update({
      where: { id },
      data: { status: "deleted", deletedAt: new Date() },
    });

    // Reclaim quota immediately so users see free space again
    if (file.status === "available" || file.status === "degraded") {
      await prisma.user.update({
        where: { id: payload.sub },
        data: { usedStorageBytes: { decrement: file.sizeBytes } },
      });
    }

    return reply.status(204).send();
  });

  // GET /api/v1/files/trash — list trashed files for the authenticated user
  fastify.get("/trash", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const files = await prisma.swarmFile.findMany({
      where: { ownerId: payload.sub, deletedAt: { not: null } },
      orderBy: { deletedAt: "desc" },
      select: {
        id: true, name: true, path: true, mimeType: true, sizeBytes: true,
        status: true, tier: true, deletedAt: true, createdAt: true,
      },
    });
    return reply.send({ files });
  });

  // POST /api/v1/files/:id/restore — restore a trashed file
  fastify.post("/:id/restore", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id } = request.params as { id: string };

    const file = await prisma.swarmFile.findFirst({
      where: { id, ownerId: payload.sub, deletedAt: { not: null } },
    });
    if (!file) return reply.status(404).send({ error: "File not found in trash" });

    // Check whether chunks are still intact to determine restored status
    const chunkCount = await prisma.fileChunk.count({ where: { fileId: id } });
    const restoredStatus = chunkCount > 0 ? "available" : "pending";

    // Re-add quota contribution
    await prisma.user.update({
      where: { id: payload.sub },
      data: { usedStorageBytes: { increment: file.sizeBytes } },
    });

    const restored = await prisma.swarmFile.update({
      where: { id },
      data: { status: restoredStatus, deletedAt: null },
    });
    return reply.send({ file: restored });
  });

  // DELETE /api/v1/files/:id/permanent — hard-delete a trashed file forever
  fastify.delete("/:id/permanent", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id } = request.params as { id: string };

    const file = await prisma.swarmFile.findFirst({
      where: { id, ownerId: payload.sub, deletedAt: { not: null } },
    });
    if (!file) return reply.status(404).send({ error: "File not found in trash" });

    // Cascade deletes FileChunk, ChunkLocation, SharedFile, RetrievalJob
    await prisma.swarmFile.delete({ where: { id } });
    return reply.status(204).send();
  });

  // POST /api/v1/files/:id/claim — Tier-2 claim: queue retrieval job
  fastify.post("/:id/claim", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id } = request.params as { id: string };
    const body = claimFileBody.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "Validation failed" });
    }

    const file = await prisma.swarmFile.findFirst({
      where: { id, ownerId: payload.sub, tier: "swarm" },
    });
    if (!file) {
      return reply.status(404).send({ error: "Swarm file not found" });
    }
    if (file.status === "deleted") {
      return reply.status(410).send({ error: "File has been deleted" });
    }

    // Update file status and create retrieval job
    const [, job] = await prisma.$transaction([
      prisma.swarmFile.update({ where: { id }, data: { status: "claimed" } }),
      prisma.retrievalJob.create({
        data: {
          fileId: id,
          requestedBy: payload.sub,
          shutdownAfterDownload: body.data.shutdownAfterDownload,
          status: "queued",
        },
      }),
    ]);

    return reply.status(202).send({ job });
  });

  // GET /api/v1/files/:id/assignment — poll for a shard assignment (used after a queued 202 response)
  fastify.get("/:id/assignment", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id } = request.params as { id: string };

    const file = await prisma.swarmFile.findFirst({
      where: { id, ownerId: payload.sub },
      select: { id: true, status: true, tier: true, totalShards: true, parityShards: true },
    });
    if (!file) return reply.status(404).send({ error: "File not found" });
    if (file.status !== "pending") {
      return reply.status(409).send({ error: "File is no longer pending", status: file.status });
    }

    // 1. Check cache first
    const cached = await distributionService.getCachedAssignment(fastify.redis, id);
    if (cached) return reply.send({ shardAssignment: cached, source: "cache" });

    // 2. Try a live assignment
    const totalShards = file.totalShards + file.parityShards;
    try {
      const assignment = await distributionService.assignNodes(
        id,
        totalShards,
        file.tier as "vault" | "swarm"
      );
      await fastify.redis.set(
        `swarmvault:assignment:${id}`,
        JSON.stringify(assignment),
        "EX",
        3600
      );
      // Remove from pending queue since we have an assignment now
      await fastify.redis.srem("swarmvault:pending-distribution", id);
      return reply.send({ shardAssignment: assignment, source: "live" });
    } catch {
      return reply.status(503).send({
        error: "Not enough online nodes yet. Retry later.",
        shardAssignment: null,
      });
    }
  });

  // GET /api/v1/files/:id/retrieval-status — poll retrieval job status
  fastify.get("/:id/retrieval-status", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id } = request.params as { id: string };

    const job = await prisma.retrievalJob.findFirst({
      where: { fileId: id, requestedBy: payload.sub },
      orderBy: { createdAt: "desc" },
    });

    if (!job) return reply.status(404).send({ error: "No retrieval job found" });
    return reply.send({ job });
  });
}
