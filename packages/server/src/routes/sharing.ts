/**
 * File Sharing routes
 *
 * POST /api/v1/files/:id/share
 *   – Owner uploads the decrypted file bytes; server stores them as a shadow
 *     copy for up to 7 days and returns a public share token.
 *
 * PUT  /api/v1/files/:id/share
 *   – Owner re-uploads new plaintext when the source file is updated.  The
 *     expiry is NOT extended; only the data is replaced.
 *
 * DELETE /api/v1/files/:id/share
 *   – Owner revokes the share immediately.
 *
 * GET  /api/v1/share/:token           (public, no auth)
 *   – Anyone with the token downloads the shadow copy while it is valid.
 */

import { FastifyInstance } from "fastify";
import { prisma } from "../database.js";

const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function sharingRoutes(fastify: FastifyInstance): Promise<void> {
  // Accept raw binary bodies (plaintext file bytes from the desktop client)
  fastify.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  const preHandler = [fastify.authenticate];

  // ── POST /api/v1/files/:id/share ──────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    "/:id/share",
    { preHandler },
    async (request, reply) => {
      const { sub: userId } = request.user as { sub: string };
      const { id: fileId } = request.params;

      const file = await prisma.swarmFile.findFirst({
        where: { id: fileId, ownerId: userId },
      });
      if (!file) return reply.status(404).send({ error: "File not found" });

      // Expect raw binary body — multipart/form-data isn't needed; the client
      // sends application/octet-stream with a Content-Disposition name header.
      const data = await request.body as Buffer;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        return reply.status(400).send({ error: "Empty or missing file body" });
      }
      // Prisma's Bytes type requires Uint8Array<ArrayBuffer>. Copy into a fresh
      // ArrayBuffer so TypeScript is happy (Buffer.buffer is ArrayBufferLike).
      const ab = new ArrayBuffer(data.length);
      const bytes = new Uint8Array(ab);
      bytes.set(data);

      const expiresAt = new Date(Date.now() + SHARE_TTL_MS);

      // Upsert: if a share already exists for this file, replace the data
      // but keep the original expiry (per spec: update data, not duration).
      const existing = await prisma.sharedFile.findFirst({
        where: { fileId, ownerId: userId },
      });

      let shared;
      if (existing) {
        shared = await prisma.sharedFile.update({
          where: { id: existing.id },
          data: {
            data: bytes,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: BigInt(data.length),
            // expiresAt intentionally NOT updated
          },
        });
      } else {
        shared = await prisma.sharedFile.create({
          data: {
            fileId,
            ownerId: userId,
            data: bytes,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: BigInt(data.length),
            expiresAt,
          },
        });
      }

      const shareUrl = `${request.protocol}://${request.hostname}/api/v1/share/${shared.token}`;

      return reply.status(existing ? 200 : 201).send({
        token: shared.token,
        shareUrl,
        expiresAt: shared.expiresAt,
      });
    }
  );

  // ── DELETE /api/v1/files/:id/share ────────────────────────────────────────
  fastify.delete<{ Params: { id: string } }>(
    "/:id/share",
    { preHandler },
    async (request, reply) => {
      const { sub: userId } = request.user as { sub: string };
      const { id: fileId } = request.params;

      const existing = await prisma.sharedFile.findFirst({
        where: { fileId, ownerId: userId },
      });
      if (!existing) return reply.status(404).send({ error: "No active share" });

      await prisma.sharedFile.delete({ where: { id: existing.id } });
      return reply.status(204).send();
    }
  );

  // ── GET /api/v1/files/:id/share  (owner: check share status) ──────────────
  fastify.get<{ Params: { id: string } }>(
    "/:id/share",
    { preHandler },
    async (request, reply) => {
      const { sub: userId } = request.user as { sub: string };
      const { id: fileId } = request.params;

      const shared = await prisma.sharedFile.findFirst({
        where: { fileId, ownerId: userId },
        select: { token: true, expiresAt: true, createdAt: true, sizeBytes: true },
      });

      if (!shared) return reply.status(404).send({ error: "No active share" });
      if (shared.expiresAt < new Date()) {
        // Expired — clean up lazily
        await prisma.sharedFile.deleteMany({ where: { fileId, ownerId: userId } });
        return reply.status(404).send({ error: "Share has expired" });
      }

      const shareUrl = `${request.protocol}://${request.hostname}/api/v1/share/${shared.token}`;
      return reply.send({ token: shared.token, shareUrl, expiresAt: shared.expiresAt, createdAt: shared.createdAt });
    }
  );
}

// ── GET /api/v1/share/:token  (public download) ──────────────────────────────
export async function publicShareRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { token: string } }>(
    "/:token",
    async (request, reply) => {
      const { token } = request.params;

      const shared = await prisma.sharedFile.findUnique({ where: { token } });
      if (!shared) return reply.status(404).send({ error: "Share not found" });
      if (shared.expiresAt < new Date()) {
        await prisma.sharedFile.delete({ where: { token } });
        return reply.status(410).send({ error: "Share has expired" });
      }

      return reply
        .header("Content-Type", shared.mimeType)
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(shared.name)}`)
        .header("Content-Length", shared.sizeBytes.toString())
        .header("Cache-Control", "private, no-store")
        .send(shared.data);
    }
  );
}
