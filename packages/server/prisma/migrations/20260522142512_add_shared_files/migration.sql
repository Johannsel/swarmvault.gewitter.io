-- CreateTable
CREATE TABLE "shared_files" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/octet-stream',
    "sizeBytes" BIGINT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shared_files_token_key" ON "shared_files"("token");

-- AddForeignKey
ALTER TABLE "shared_files" ADD CONSTRAINT "shared_files_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "swarm_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_files" ADD CONSTRAINT "shared_files_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
