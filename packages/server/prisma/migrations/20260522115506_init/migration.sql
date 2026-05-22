-- CreateEnum
CREATE TYPE "StorageTier" AS ENUM ('vault', 'swarm');

-- CreateEnum
CREATE TYPE "NodeStatus" AS ENUM ('online', 'offline', 'maintenance');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('pending', 'available', 'degraded', 'claimed', 'retrieving', 'deleted');

-- CreateEnum
CREATE TYPE "RetrievalJobStatus" AS ENUM ('queued', 'waiting_nodes', 'assembling', 'done', 'failed');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "storageQuotaBytes" BIGINT NOT NULL DEFAULT 2147483648,
    "usedStorageBytes" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_nodes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "tier" "StorageTier" NOT NULL DEFAULT 'swarm',
    "status" "NodeStatus" NOT NULL DEFAULT 'offline',
    "pledgedBytes" BIGINT NOT NULL DEFAULT 0,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "relayToken" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uptimePct" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "storage_nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swarm_files" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "sizeBytes" BIGINT NOT NULL,
    "status" "FileStatus" NOT NULL DEFAULT 'pending',
    "tier" "StorageTier" NOT NULL DEFAULT 'swarm',
    "contentHash" TEXT NOT NULL,
    "totalShards" INTEGER NOT NULL,
    "parityShards" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "swarm_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_chunks" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "shardIndex" INTEGER NOT NULL,
    "isData" BOOLEAN NOT NULL DEFAULT true,
    "sizeBytes" BIGINT NOT NULL,
    "chunkHash" TEXT NOT NULL,

    CONSTRAINT "file_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunk_locations" (
    "chunkId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "storedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "chunk_locations_pkey" PRIMARY KEY ("chunkId","nodeId")
);

-- CreateTable
CREATE TABLE "retrieval_jobs" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" "RetrievalJobStatus" NOT NULL DEFAULT 'queued',
    "shutdownAfterDownload" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "retrieval_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_balances" (
    "userId" TEXT NOT NULL,
    "credits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lifetimeEarned" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_balances_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "contribution_snapshots" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "StorageTier" NOT NULL,
    "pledgedBytes" BIGINT NOT NULL,
    "uptimePct" DOUBLE PRECISION NOT NULL,
    "creditsEarned" DOUBLE PRECISION NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contribution_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "storage_nodes_relayToken_key" ON "storage_nodes"("relayToken");

-- CreateIndex
CREATE UNIQUE INDEX "swarm_files_ownerId_path_key" ON "swarm_files"("ownerId", "path");

-- CreateIndex
CREATE UNIQUE INDEX "file_chunks_fileId_shardIndex_key" ON "file_chunks"("fileId", "shardIndex");

-- AddForeignKey
ALTER TABLE "storage_nodes" ADD CONSTRAINT "storage_nodes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swarm_files" ADD CONSTRAINT "swarm_files_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_chunks" ADD CONSTRAINT "file_chunks_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "swarm_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk_locations" ADD CONSTRAINT "chunk_locations_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "file_chunks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunk_locations" ADD CONSTRAINT "chunk_locations_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "storage_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retrieval_jobs" ADD CONSTRAINT "retrieval_jobs_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "swarm_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retrieval_jobs" ADD CONSTRAINT "retrieval_jobs_requestedBy_fkey" FOREIGN KEY ("requestedBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_balances" ADD CONSTRAINT "reward_balances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contribution_snapshots" ADD CONSTRAINT "contribution_snapshots_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "storage_nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contribution_snapshots" ADD CONSTRAINT "contribution_snapshots_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
