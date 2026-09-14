import { z } from 'zod';

/** cuid2, as emitted by Prisma's default. */
export const idSchema = z.string().min(21).max(32);

/** URL-safe nanoid used for shareable room links (spec section 3). */
export const roomSlugSchema = z.string().regex(/^[A-Za-z0-9_-]{10,24}$/, 'Invalid room link');

export const emailSchema = z.email().max(254).toLowerCase().trim();

export const displayNameSchema = z.string().trim().min(1).max(64);

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export type Id = z.infer<typeof idSchema>;
export type RoomSlug = z.infer<typeof roomSlugSchema>;
export type Pagination = z.infer<typeof paginationSchema>;
