import { EventEmitter } from 'node:events';

/**
 * Lets the REST layer announce room changes without importing Socket.IO,
 * mirroring auth-events.ts. The room gateway subscribes and fans the change
 * out to everyone in the room.
 */
export interface RoomEvents {
  'room-updated': [payload: { slug: string; name: string; isLocked: boolean }];
  'room-ended': [payload: { slug: string }];
}

export const roomEvents = new EventEmitter<RoomEvents>();
