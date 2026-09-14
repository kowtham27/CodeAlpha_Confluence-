import { z } from 'zod';
import { roomSlugSchema } from './common.js';

/** Socket.IO ids: 20 URL-safe characters. Bounded so a payload cannot smuggle bulk. */
export const peerIdSchema = z.string().min(1).max(64);

export const mediaStateSchema = z.object({
  audio: z.boolean(),
  video: z.boolean(),
});
export type MediaState = z.infer<typeof mediaStateSchema>;

/**
 * An SDP offer or answer. 64 KB is generous: a real two-track SDP is 4-8 KB.
 * The cap is what matters, so one peer cannot push megabytes through the relay.
 */
export const sessionDescriptionSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1).max(64_000),
});

/** RTCIceCandidateInit, bounded. */
export const iceCandidateSchema = z.object({
  candidate: z.string().max(2_048),
  sdpMid: z.string().max(64).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional(),
});

/**
 * Random id of the sender's current connection set. A peer that sees a new
 * session from someone it already knows learns they rebuilt (reload, tab
 * takeover, dev double-mount) and rebuilds its side to match, instead of
 * applying a stranger's offer to the old connection.
 */
export const signalSessionSchema = z.string().min(1).max(64);

export const signalDescriptionRequestSchema = z.object({
  to: peerIdSchema,
  session: signalSessionSchema,
  description: sessionDescriptionSchema,
});

export const signalIceRequestSchema = z.object({
  to: peerIdSchema,
  session: signalSessionSchema,
  /** null signals end-of-candidates. */
  candidate: iceCandidateSchema.nullable(),
});

export const mediaStateRequestSchema = z.object({
  slug: roomSlugSchema,
  audio: z.boolean(),
  video: z.boolean(),
});

/** Who holds the room's single screen-share slot. */
export const screenSharerSchema = z.object({
  userId: z.string(),
  peerId: peerIdSchema,
  displayName: z.string(),
  since: z.string(),
});

export const screenRequestSchema = z.object({ slug: roomSlugSchema });

/** RTCIceServer as the browser expects it. */
export const iceServerSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});

export type SessionDescription = z.infer<typeof sessionDescriptionSchema>;
export type IceCandidate = z.infer<typeof iceCandidateSchema>;
export type SignalDescriptionRequest = z.infer<typeof signalDescriptionRequestSchema>;
export type SignalIceRequest = z.infer<typeof signalIceRequestSchema>;
export type MediaStateRequest = z.infer<typeof mediaStateRequestSchema>;
export type IceServer = z.infer<typeof iceServerSchema>;
export type ScreenSharer = z.infer<typeof screenSharerSchema>;
export type ScreenRequest = z.infer<typeof screenRequestSchema>;
