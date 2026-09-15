import { Router } from 'express';
import { z } from 'zod';
import { roomSlugSchema } from '@confluence/shared';
import { asyncHandler } from '../../middleware/async-handler.js';
import { getAuth, requireAuth } from '../../middleware/require-auth.js';
import { history } from './chat.service.js';

export const chatRouter: Router = Router();

const querySchema = z.object({ before: z.uuid().optional() });

/** A page of a room's encrypted chat history; new messages arrive over the socket. */
chatRouter.get(
  '/rooms/:slug/messages',
  requireAuth,
  asyncHandler(async (req, res) => {
    const slug = roomSlugSchema.parse(req.params['slug']);
    const { before } = querySchema.parse(req.query);
    res.json(await history(slug, getAuth(req).userId, before));
  }),
);
