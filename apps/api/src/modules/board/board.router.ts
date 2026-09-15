import { Router } from 'express';
import { roomSlugSchema } from '@confluence/shared';
import { asyncHandler } from '../../middleware/async-handler.js';
import { getAuth, requireAuth } from '../../middleware/require-auth.js';
import { getSnapshot } from './board.service.js';

export const boardRouter: Router = Router();

/** The board as of now, for someone opening it; live ops follow over the socket. */
boardRouter.get(
  '/rooms/:slug/board',
  requireAuth,
  asyncHandler(async (req, res) => {
    const slug = roomSlugSchema.parse(req.params['slug']);
    res.json(await getSnapshot(slug, getAuth(req).userId));
  }),
);
