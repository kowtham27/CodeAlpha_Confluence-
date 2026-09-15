-- Phase 6: the whiteboard keeps only live elements, keyed by element id, and
-- orders changes with a per-room counter. WhiteboardOp has never been written
-- before this migration, so adding a NOT NULL column needs no backfill.

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "boardSeq" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "WhiteboardOp" ADD COLUMN     "elementId" UUID NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "WhiteboardOp_roomId_elementId_key" ON "WhiteboardOp"("roomId", "elementId");

