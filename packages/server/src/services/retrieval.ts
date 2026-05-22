/**
 * Retrieval coordinator.
 *
 * Sends `chunk_request` messages to connected storage nodes and collects the
 * encrypted shard bytes they send back via `chunk_response`.  The server
 * never decrypts shards — it acts purely as a relay so the client can
 * perform decryption and Reed-Solomon reconstruction locally.
 */

import type { WebSocket } from "@fastify/websocket";
import { prisma } from "../database.js";

/** How long (ms) to wait for a node to respond with a shard before giving up. */
const SHARD_RESPONSE_TIMEOUT_MS = 30_000;

export interface ShardData {
  index: number;
  /** Raw encrypted bytes (IV + AuthTag + Ciphertext) */
  data: Buffer;
  chunkHash: string;
}

export interface RetrievalResult {
  name: string;
  sizeBytes: number;
  /** AES-256-GCM master key, encoded as received from the uploader */
  encryptedMasterKey: string;
  totalShards: number;
  parityShards: number;
  shards: ShardData[];
}

export const retrievalService = {
  /**
   * Collect all available encrypted shards for `fileId` from currently
   * connected storage nodes.
   *
   * Fires a `chunk_request` WS message at every node that has a shard and is
   * presently connected, then awaits the `chunk_response` callbacks that the
   * main WS handler will call via `pendingChunkResponses`.
   *
   * Throws with a `statusCode` property so callers can set the HTTP status.
   */
  async fetchAllShards(fileId: string, ownerId: string, nodeConnections: Map<string, WebSocket>, pendingChunkResponses: Map<string, (data: Buffer | null) => void>): Promise<RetrievalResult> {
    const file = await prisma.swarmFile.findFirst({
      where: { id: fileId, ownerId },
      include: {
        chunks: {
          include: { locations: true },
          orderBy: { shardIndex: "asc" },
        },
      },
    });

    if (!file) {
      throw Object.assign(new Error("File not found"), { statusCode: 404 });
    }
    if (file.status === "deleted") {
      throw Object.assign(new Error("File has been deleted"), { statusCode: 410 });
    }
    if (file.chunks.length === 0) {
      throw Object.assign(new Error("File has no stored shards yet"), { statusCode: 503 });
    }

    // Fire requests for every shard in parallel
    const shardPromises = file.chunks.map(async (chunk): Promise<ShardData | null> => {
      // Pick the first connected node that holds this shard
      const connectedNodeId = chunk.locations.map((loc) => loc.nodeId).find((nid) => nodeConnections.has(nid));

      if (!connectedNodeId) {
        return null; // shard not reachable right now
      }

      const socket = nodeConnections.get(connectedNodeId)!;
      const key = `${fileId}:${chunk.shardIndex}`;

      const responsePromise = new Promise<Buffer | null>((resolve) => {
        const timer = setTimeout(() => {
          pendingChunkResponses.delete(key);
          resolve(null);
        }, SHARD_RESPONSE_TIMEOUT_MS);

        pendingChunkResponses.set(key, (data: Buffer | null) => {
          clearTimeout(timer);
          pendingChunkResponses.delete(key);
          resolve(data);
        });
      });

      // Ask the node to send back this shard
      socket.send(
        JSON.stringify({
          type: "chunk_request",
          payload: { fileId, shardIndex: chunk.shardIndex },
        }),
      );

      const data = await responsePromise;
      if (!data) return null;

      return { index: chunk.shardIndex, data, chunkHash: chunk.chunkHash };
    });

    const results = await Promise.all(shardPromises);
    const shards = results.filter((s): s is ShardData => s !== null);

    // Need at least `totalShards` data shards to allow reconstruction
    if (shards.length < file.totalShards) {
      throw Object.assign(new Error(`Only ${shards.length} of ${file.totalShards} required shards are currently reachable. ` + `Try again when more nodes are online.`), { statusCode: 503 });
    }

    return {
      name: file.name,
      sizeBytes: Number(file.sizeBytes),
      encryptedMasterKey: file.encryptedMasterKey,
      totalShards: file.totalShards,
      parityShards: file.parityShards,
      shards,
    };
  },
};
