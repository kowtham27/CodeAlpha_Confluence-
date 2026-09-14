import {
  roomListResponseSchema,
  roomResponseSchema,
  roomSlugSchema,
  type RoomSummary,
  type UpdateRoomRequest,
} from '@confluence/shared';
import { request } from './api';

export async function createRoom(name: string): Promise<RoomSummary> {
  const { room } = await request('/rooms', {
    method: 'POST',
    body: { name },
    schema: roomResponseSchema,
    auth: true,
  });
  return room;
}

export async function listRooms(): Promise<RoomSummary[]> {
  const { rooms } = await request('/rooms', { schema: roomListResponseSchema, auth: true });
  return rooms;
}

export async function updateRoom(slug: string, patch: UpdateRoomRequest): Promise<RoomSummary> {
  const { room } = await request(`/rooms/${slug}`, {
    method: 'PATCH',
    body: patch,
    schema: roomResponseSchema,
    auth: true,
  });
  return room;
}

export async function endRoom(slug: string): Promise<void> {
  await request(`/rooms/${slug}/end`, { method: 'POST', auth: true });
}

export const inviteLink = (slug: string): string => `${window.location.origin}/r/${slug}`;

/**
 * Accepts what people actually paste: a full invite link, a path, or a bare
 * code. Returns the slug, or null if it is not a valid one.
 */
export function parseRoomInput(input: string): string | null {
  const trimmed = input.trim();
  const candidate = trimmed.match(/\/r\/([^/?#\s]+)/)?.[1] ?? trimmed;
  const parsed = roomSlugSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
