import { z } from 'zod';
import { roomSlugSchema } from './common.js';
import { iceServerSchema, mediaStateSchema } from './rtc.js';

export const ROOM_ROLES = ['OWNER', 'MODERATOR', 'GUEST'] as const;
export const roomRoleSchema = z.enum(ROOM_ROLES);
export type RoomRole = z.infer<typeof roomRoleSchema>;

export const roomNameSchema = z.string().trim().min(1, 'Give the room a name').max(80);

// ---- REST -------------------------------------------------------------------

export const createRoomRequestSchema = z.object({ name: roomNameSchema });

export const updateRoomRequestSchema = z
  .object({
    name: roomNameSchema.optional(),
    isLocked: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.isLocked !== undefined, {
    message: 'Nothing to update',
  });

export const roomSummarySchema = z.object({
  slug: roomSlugSchema,
  name: z.string(),
  isLocked: z.boolean(),
  maxParticipants: z.number().int().positive(),
  createdAt: z.string(),
  /** Set once the owner ends the meeting; an ended room cannot be joined. */
  endedAt: z.string().nullable(),
  owner: z.object({ displayName: z.string() }),
  /** The caller's role, or null if they have never joined. */
  myRole: roomRoleSchema.nullable(),
  /** People in the room right now (live presence, not membership). */
  participantCount: z.number().int().nonnegative(),
});

export const roomResponseSchema = z.object({ room: roomSummarySchema });
export const roomListResponseSchema = z.object({ rooms: z.array(roomSummarySchema) });

// ---- Realtime ---------------------------------------------------------------

export const participantSchema = z.object({
  /** Socket id: the address WebRTC signaling is sent to. */
  peerId: z.string(),
  userId: z.string(),
  displayName: z.string(),
  role: roomRoleSchema,
  joinedAt: z.string(),
  /** Mic and camera on/off, so every tile can show a mute indicator. */
  media: mediaStateSchema,
});

export const roomJoinRequestSchema = z.object({
  slug: roomSlugSchema,
  /** What the joiner is sending as they arrive; updated later with media:state. */
  media: mediaStateSchema.default({ audio: false, video: false }),
});
export const roomLeaveRequestSchema = z.object({ slug: roomSlugSchema });

export const roomJoinResultSchema = z.object({
  room: roomSummarySchema,
  self: participantSchema,
  /**
   * STUN and TURN servers, with TURN credentials minted for this user at join
   * time. The client never holds a long-lived TURN secret.
   */
  iceServers: z.array(iceServerSchema),
});

/** Why someone is no longer in the room. Drives the wording in the UI. */
export const PEER_LEFT_REASONS = [
  'left',
  'disconnected',
  /** Their server stopped heartbeating (crashed); swept after a timeout. */
  'timeout',
  /** They joined again from another tab or device. */
  'displaced',
  'ended',
] as const;
export type PeerLeftReason = (typeof PEER_LEFT_REASONS)[number];

export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;
export type UpdateRoomRequest = z.infer<typeof updateRoomRequestSchema>;
export type RoomSummary = z.infer<typeof roomSummarySchema>;
export type Participant = z.infer<typeof participantSchema>;
export type RoomJoinRequest = z.input<typeof roomJoinRequestSchema>;
export type RoomLeaveRequest = z.infer<typeof roomLeaveRequestSchema>;
export type RoomJoinResult = z.infer<typeof roomJoinResultSchema>;
