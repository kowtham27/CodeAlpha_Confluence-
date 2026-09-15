import {
  keyRequestsResponseSchema,
  roomKeyStateSchema,
  userKeysSchema,
  type InitRoomKeyRequest,
  type KeyRequest,
  type RoomKeyState,
  type SetUserKeysRequest,
  type UserKeys,
} from '@confluence/shared';
import { request } from '../api';

export const getMyKeys = (): Promise<UserKeys> =>
  request('/me/keys', { schema: userKeysSchema, auth: true });

export const setMyKeys = (keys: SetUserKeysRequest): Promise<void> =>
  request('/me/keys', { method: 'PUT', body: keys, auth: true });

export const getRoomKey = (slug: string): Promise<RoomKeyState> =>
  request(`/rooms/${slug}/key`, { schema: roomKeyStateSchema, auth: true });

export const initRoomKey = (slug: string, body: InitRoomKeyRequest): Promise<void> =>
  request(`/rooms/${slug}/key`, { method: 'PUT', body, auth: true });

export async function getKeyRequests(slug: string): Promise<KeyRequest[]> {
  const { requests } = await request(`/rooms/${slug}/key/requests`, {
    schema: keyRequestsResponseSchema,
    auth: true,
  });
  return requests;
}

export const grantRoomKey = (slug: string, userId: string, wrappedRoomKey: string): Promise<void> =>
  request(`/rooms/${slug}/key/grants`, {
    method: 'POST',
    body: { userId, wrappedRoomKey },
    auth: true,
  });

export const clearMyRoomKey = (slug: string): Promise<void> =>
  request(`/rooms/${slug}/key/mine`, { method: 'DELETE', auth: true });
