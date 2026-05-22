import { FastifyRequest, FastifyReply } from "fastify";

/**
 * Fastify preHandler that verifies the JWT and attaches the decoded payload
 * to `request.user`.  Register via `fastify.decorate` and use as a preHandler
 * hook on protected routes.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    await reply.status(401).send({ error: "Unauthorized" });
  }
}
