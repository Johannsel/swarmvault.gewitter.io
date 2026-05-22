/*
  Warnings:

  - Added the required column `encryptedMasterKey` to the `swarm_files` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable: add with a temporary default for existing rows, then drop the default
ALTER TABLE "swarm_files" ADD COLUMN "encryptedMasterKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "swarm_files" ALTER COLUMN "encryptedMasterKey" DROP DEFAULT;
