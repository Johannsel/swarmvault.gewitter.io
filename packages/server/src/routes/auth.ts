import { FastifyInstance } from "fastify";
import { z } from "zod";
import { hash, verify } from "argon2";
import { prisma } from "../database.js";

const registerBody = z.object({
  email: z.string().email(),
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(10).max(128),
});

const loginBody = z.object({
  email: z.string().email(),
  password: z.string(),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/auth/register
  fastify.post(
    "/register",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = registerBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "Validation failed", details: body.error.flatten() });
      }

      const { email, username, password } = body.data;

      const existing = await prisma.user.findFirst({
        where: { OR: [{ email }, { username }] },
      });
      if (existing) {
        return reply.status(409).send({ error: "Email or username already taken" });
      }

      const passwordHash = await hash(password);

      const user = await prisma.user.create({
        data: {
          email,
          username,
          passwordHash,
          rewards: { create: {} },
        },
      });

      const token = fastify.jwt.sign({
        sub: user.id,
        email: user.email,
        username: user.username,
      });

      return reply.status(201).send({
        token,
        user: { id: user.id, email: user.email, username: user.username },
      });
    },
  );

  // POST /api/v1/auth/login
  fastify.post(
    "/login",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const body = loginBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "Validation failed" });
      }

      const { email, password } = body.data;

      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const valid = await verify(user.passwordHash, password);
      if (!valid) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const token = fastify.jwt.sign({
        sub: user.id,
        email: user.email,
        username: user.username,
      });

      return reply.send({
        token,
        user: { id: user.id, email: user.email, username: user.username },
      });
    },
  );

  // GET /api/v1/auth/me
  fastify.get(
    "/me",
    {
      preHandler: [fastify.authenticate],
    },
    async (request, reply) => {
      const payload = request.user as { sub: string };
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          username: true,
          createdAt: true,
          storageQuotaBytes: true,
          usedStorageBytes: true,
        },
      });
      if (!user) return reply.status(404).send({ error: "User not found" });
      return reply.send({ user });
    },
  );
}
