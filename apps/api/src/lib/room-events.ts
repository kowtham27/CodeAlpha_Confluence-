import { EventEmitter } from 'node:events';
import type { FileSummary } from '@confluence/shared';

/**
 * Lets the REST layer announce room changes without importing Socket.IO,
 * mirroring auth-events.ts. The room gateway subscribes and fans each change
 * out to the right sockets.
 */
export interface RoomEvents {
  'room-updated': [payload: { slug: string; name: string; isLocked: boolean }];
  'room-ended': [payload: { slug: string }];
  'file-shared': [payload: { slug: string; file: FileSummary }];
  'file-deleted': [payload: { slug: string; fileId: string }];
  /** Someone in the room lacks the room key; holders should grant it. */
  'key-requested': [payload: { slug: string }];
  /** The room key was sealed to `userId`; tell only them. */
  'key-granted': [payload: { slug: string; userId: string }];
}

export const roomEvents = new EventEmitter<RoomEvents>();
