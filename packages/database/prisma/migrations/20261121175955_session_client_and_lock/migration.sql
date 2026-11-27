-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "client" VARCHAR(8) NOT NULL DEFAULT 'web',
ADD COLUMN     "locked_at" TIMESTAMP(3);
