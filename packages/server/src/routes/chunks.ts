import { createHash, randomBytes } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import type { Redis } from "ioredis";
import { FastifyInstance } from "fastify";
import { prisma } from "../database.js";
import { distributionService } from "../services/distribution.js";

/** How long (ms) the server waits for a node to ack a relayed chunk. */
const CHUNK_ACK_TIMEOUT_MS = 30_000;

type ChunkFastify = FastifyInstance & {
  nodeConnections: Map<string, WebSocket>;
  pendingAcks: Map<string, (ok: boolean) => void>;
  redis: Redis;
};

export async function chunkRoutes(fastify: ChunkFastify): Promise<void> {
  // Accept raw binary bodies for this plugin scope
  fastify.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

  const preHandler = [fastify.authenticate];

  /**
   * POST /api/v1/chunks
   *
   * Upload one encrypted shard. The server relays it to the assigned storage
   * node via its persistent WebSocket connection, waits for a `chunk_ack`,
   * then records the chunk in the database.
   *
   * Metadata is passed via request headers to keep the body purely binary:
   *   X-File-Id      — SwarmFile.id
   *   X-Shard-Index  — 0-based shard position
   *   X-Chunk-Hash   — SHA-256 hex of the encrypted bytes
   *   X-Is-Data      — "true" | "false"  (false = parity shard)
   *   X-Node-Id      — target StorageNode.id from the shard assignment
   */
  fastify.post("/", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };

    const fileId = request.headers["x-file-id"] as string | undefined;
    const shardIndexRaw = request.headers["x-shard-index"] as string | undefined;
    const chunkHash = request.headers["x-chunk-hash"] as string | undefined;
    const isDataRaw = request.headers["x-is-data"] as string | undefined;
    const targetNodeId = request.headers["x-node-id"] as string | undefined;

    if (!fileId || shardIndexRaw === undefined || !chunkHash || !targetNodeId) {
      return reply.status(400).send({ error: "Missing required X-* headers" });
    }

    // Validate chunkHash is exactly 64 lowercase hex chars (SHA-256)
    if (!/^[0-9a-f]{64}$/.test(chunkHash)) {
      return reply.status(400).send({ error: "X-Chunk-Hash must be a 64-character lowercase hex SHA-256" });
    }

    const shardIndex = Number(shardIndexRaw);
    if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex > 999) {
      return reply.status(400).send({ error: "X-Shard-Index must be a non-negative integer" });
    }

    const isData = isDataRaw !== "false";

    // Verify the file belongs to the caller
    const file = await prisma.swarmFile.findFirst({
      where: { id: fileId, ownerId: payload.sub },
      select: { id: true },
    });
    if (!file) return reply.status(404).send({ error: "File not found" });

    const body = request.body as Buffer;
    if (!body || body.length === 0) {
      return reply.status(400).send({ error: "Empty body" });
    }

    // Verify the chunk hash matches the received bytes
    const actualHash = createHash("sha256").update(body).digest("hex");
    if (actualHash !== chunkHash) {
      return reply.status(400).send({ error: "Chunk hash mismatch — data may be corrupted in transit" });
    }

    // Verify the target node is live on WebSocket
    const socket = fastify.nodeConnections.get(targetNodeId);
    if (!socket || socket.readyState !== 1 /* WebSocket.OPEN */) {
      return reply.status(503).send({
        error: "Target node is not connected. The desktop app must have an open WebSocket connection.",
      });
    }

    // Generate a one-time nonce so only the node that receives THIS relay message
    // can resolve the ack — prevents a malicious node from DoS-ing another node's upload.
    const ackNonce = randomBytes(8).toString("hex");
    const ackKey = `${fileId}:${shardIndex}:${ackNonce}`;
    const ackPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        fastify.pendingAcks.delete(ackKey);
        resolve(false);
      }, CHUNK_ACK_TIMEOUT_MS);

      fastify.pendingAcks.set(ackKey, (ok: boolean) => {
        clearTimeout(timer);
        fastify.pendingAcks.delete(ackKey);
        resolve(ok);
      });
    });

    // Relay the chunk to the node as base64 inside a JSON envelope
    socket.send(
      JSON.stringify({
        type: "chunk_relay",
        payload: {
          fileId,
          shardIndex,
          chunkHash,
          isData,
          ackNonce,
          data: body.toString("base64"),
        },
      }),
    );

    const acked = await ackPromise;
    if (!acked) {
      return reply.status(504).send({
        error: "Node did not acknowledge the chunk within the timeout. The shard was not stored.",
      });
    }

    // Persist the chunk location in the database
    await distributionService.recordChunkStored({
      fileId,
      shardIndex,
      isData,
      sizeBytes: body.length,
      chunkHash,
      nodeId: targetNodeId,
    });

    return reply.send({ ok: true, fileId, shardIndex });
  });
}
