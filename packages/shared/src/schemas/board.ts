import { z } from 'zod';
import { base64UrlSchema } from './keys.js';
import { roomSlugSchema } from './common.js';

/**
 * The collaborative whiteboard (spec Phase 6).
 *
 * Every element is encrypted in the browser with the room key before it is
 * sent, so the server stores and relays ciphertext it cannot read. It sees
 * only what it needs to keep the board consistent: element ids, the order of
 * operations (`seq`), and who made them.
 */

/** The board's logical coordinate space. Every screen scales it to fit. */
export const BOARD_WIDTH = 1600;
export const BOARD_HEIGHT = 1000;
/** Live elements per room. Clearing or erasing makes room. */
export const MAX_BOARD_ELEMENTS = 2000;

export const BOARD_COLORS = [
  '#1f2937',
  '#dc2626',
  '#ea580c',
  '#16a34a',
  '#2563eb',
  '#9333ea',
] as const;

export const boardElementIdSchema = z.uuid();

// ---- the wire: what the server sees ------------------------------------------------

/** One encrypted element. Generous for a long stroke (4,000 points). */
export const boardCiphertextSchema = base64UrlSchema(64_000);

export const boardAddRequestSchema = z.object({
  slug: roomSlugSchema,
  id: boardElementIdSchema,
  ciphertext: boardCiphertextSchema,
});

export const boardRemoveRequestSchema = z.object({
  slug: roomSlugSchema,
  ids: z.array(boardElementIdSchema).min(1).max(500),
});

export const boardClearRequestSchema = z.object({ slug: roomSlugSchema });

/**
 * An element still being drawn, so others see it take shape. Relayed, never
 * stored. `ciphertext: null` means the draft is over (committed or dropped).
 */
export const boardDraftRequestSchema = z.object({
  slug: roomSlugSchema,
  id: boardElementIdSchema,
  ciphertext: base64UrlSchema(24_000).nullable(),
});

/** Where the sender's pointer is on the board; null when it leaves. Relayed only. */
export const boardCursorRequestSchema = z.object({
  slug: roomSlugSchema,
  ciphertext: base64UrlSchema(256).nullable(),
});

export const boardStoredElementSchema = z.object({
  id: boardElementIdSchema,
  seq: z.number().int().positive(),
  ciphertext: z.string(),
  authorId: z.string(),
});

/** A change to the board, in the order the server applied it. */
export const boardOpSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add'),
    seq: z.number().int().positive(),
    element: boardStoredElementSchema,
  }),
  z.object({
    kind: z.literal('remove'),
    seq: z.number().int().positive(),
    ids: z.array(boardElementIdSchema),
  }),
  z.object({ kind: z.literal('clear'), seq: z.number().int().positive() }),
]);

/** Everything on the board as of `seq`. */
export const boardSnapshotSchema = z.object({
  seq: z.number().int().nonnegative(),
  elements: z.array(boardStoredElementSchema),
});

export const boardAckSchema = z.object({ seq: z.number().int().positive() });

// ---- inside the ciphertext: what members see --------------------------------------
// Validated after decryption: another member's browser wrote it, so it is
// untrusted input like anything else.

const coord = z
  .number()
  .int()
  .min(-400)
  .max(BOARD_WIDTH + 400);
const color = z.enum(BOARD_COLORS);
const width = z.number().int().min(1).max(40);

export const boardElementSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stroke'),
    color,
    width,
    /** Flat [x0, y0, x1, y1, ...]. */
    points: z
      .array(coord)
      .min(2)
      .max(8000)
      .refine((p) => p.length % 2 === 0, 'Points come in pairs'),
  }),
  z.object({
    type: z.enum(['line', 'arrow', 'rect', 'ellipse']),
    color,
    width,
    x1: coord,
    y1: coord,
    x2: coord,
    y2: coord,
  }),
  z.object({
    type: z.literal('text'),
    color,
    size: z.number().int().min(12).max(96),
    x: coord,
    y: coord,
    text: z.string().min(1).max(500),
  }),
]);

export const boardCursorSchema = z.object({ x: coord, y: coord });

export type BoardAddRequest = z.infer<typeof boardAddRequestSchema>;
export type BoardRemoveRequest = z.infer<typeof boardRemoveRequestSchema>;
export type BoardClearRequest = z.infer<typeof boardClearRequestSchema>;
export type BoardDraftRequest = z.infer<typeof boardDraftRequestSchema>;
export type BoardCursorRequest = z.infer<typeof boardCursorRequestSchema>;
export type BoardStoredElement = z.infer<typeof boardStoredElementSchema>;
export type BoardOp = z.infer<typeof boardOpSchema>;
export type BoardSnapshot = z.infer<typeof boardSnapshotSchema>;
export type BoardAck = z.infer<typeof boardAckSchema>;
export type BoardElement = z.infer<typeof boardElementSchema>;
export type BoardColor = (typeof BOARD_COLORS)[number];
export type BoardCursor = z.infer<typeof boardCursorSchema>;
