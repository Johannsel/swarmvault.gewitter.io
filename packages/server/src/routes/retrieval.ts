/**
 * Retrieval routes — mounted at the same prefix as fileRoutes (/api/v1/files)
 * so download lives at GET /api/v1/files/:id/download.
 */

import type { WebSocket } from "@fastify/websocket";
import type { Redis } from "ioredis";
import { FastifyInstance } from "fastify";
import { retrievalService } from "../services/retrieval.js";

type RetrievalFastify = FastifyInstance & {
  nodeConnections: Map<string, WebSocket>;
  pendingChunkResponses: Map<string, (data: Buffer | null) => void>;
  redis: Redis;
};

export async function retrievalRoutes(fastify: RetrievalFastify): Promise<void> {
  const preHandler = [fastify.authenticate];

  /**
   * GET /api/v1/files/:id/download
   *
   * Relays all encrypted shards from connected storage nodes back to the
   * requesting client. The client is responsible for:
   *   1. Decrypting each shard using the master key + per-shard key derivation
   *   2. Reed-Solomon reconstruction if any data shards were missing
   *   3. Writing the resulting plaintext to disk
   *
   * Response body:
   * {
   *   name: string,
   *   sizeBytes: number,
   *   encryptedMasterKey: string,   // base64url-encoded master key
   *   totalShards: number,
   *   parityShards: number,
   *   shards: [{ index, data, chunkHash }]  // data is base64
   * }
   */
  fastify.get<{ Params: { id: string } }>("/:id/download", { preHandler }, async (request, reply) => {
    const payload = request.user as { sub: string };
    const { id: fileId } = request.params;

    try {
      const result = await retrievalService.fetchAllShards(fileId, payload.sub, fastify.nodeConnections, fastify.pendingChunkResponses);

      return reply.send({
        name: result.name,
        sizeBytes: result.sizeBytes,
        encryptedMasterKey: result.encryptedMasterKey,
        totalShards: result.totalShards,
        parityShards: result.parityShards,
        shards: result.shards.map((s) => ({
          index: s.index,
          data: s.data.toString("base64"),
          chunkHash: s.chunkHash,
        })),
      });
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string };
      return reply.status(e.statusCode ?? 500).send({ error: e.message });
    }
  });
}
