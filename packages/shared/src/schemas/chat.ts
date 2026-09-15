import { z } from 'zod';
import { roomSlugSchema } from './common.js';
import { base64UrlSchema } from './keys.js';

/**
 * In-meeting chat (spec Phase 7), end-to-end encrypted with the room key.
 *
 * The server stores and relays ciphertext. Each message's ciphertext is bound
 * (as associated data) to the room, its sender and its id, so the server
 * cannot move a message to another room, pass one person's words off as
 * another's, or replay a message under a new id.
 */

export const MAX_CHAT_LENGTH = 2000;

export const chatSendRequestSchema = z.object({
  slug: roomSlugSchema,
  /** Chosen by the sender, so a retried send is recognised, not duplicated. */
  id: z.uuid(),
  /** 24-byte nonce + ciphertext of { text }, base64url. */
  ciphertext: base64UrlSchema(4096),
});

export const chatMessageSchema = z.object({
  id: z.uuid(),
  sender: z.object({ userId: z.string(), displayName: z.string() }),
  ciphertext: z.string(),
  createdAt: z.string(),
});

export const chatHistoryResponseSchema = z.object({
  /** Oldest first. */
  messages: z.array(chatMessageSchema),
  /** More, older messages exist: ask again with `before` = the first id here. */
  hasMore: z.boolean(),
});

/** Inside the ciphertext. */
export const chatPlaintextSchema = z.object({
  text: z.string().min(1).max(MAX_CHAT_LENGTH),
});

export type ChatSendRequest = z.infer<typeof chatSendRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatHistoryResponse = z.infer<typeof chatHistoryResponseSchema>;
export type ChatPlaintext = z.infer<typeof chatPlaintextSchema>;
