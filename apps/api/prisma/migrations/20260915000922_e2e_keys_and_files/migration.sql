-- AlterTable
ALTER TABLE "FileMeta" ADD COLUMN     "uploadedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Room" ADD COLUMN     "keyCheck" TEXT;

-- AlterTable
ALTER TABLE "RoomMember" ADD COLUMN     "wrappedRoomKey" BYTEA;
