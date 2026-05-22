import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log: config.NODE_ENV === "development" ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (config.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
