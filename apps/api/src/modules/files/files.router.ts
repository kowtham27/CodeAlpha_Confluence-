import { Router } from 'express';
import { createFileRequestSchema, roomSlugSchema } from '@confluence/shared';
import { consume, RATE_LIMITS, sendRateLimited } from '../../lib/rate-limiter.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { HttpError } from '../../middleware/error-handler.js';
import { getAuth, requireAuth } from '../../middleware/require-auth.js';
import * as files from './files.service.js';

export const filesRouter: Router = Router();

const slugOf = (value: unknown): string => roomSlugSchema.parse(value);
/** File ids are cuids; anything else cannot exist, so it is a 404, not a DB query. */
const idOf = (value: unknown): string => {
  const id = typeof value === 'string' ? value : '';
  if (!/^[a-z0-9]{20,32}$/.test(id))
    throw new HttpError('NOT_FOUND', 'That file no longer exists.');
  return id;
};

filesRouter.use('/rooms/:slug/files', requireAuth);

filesRouter.post(
  '/rooms/:slug/files',
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const limit = await consume(RATE_LIMITS.fileUpload, userId);
    if (!limit.allowed) {
      sendRateLimited(res, RATE_LIMITS.fileUpload, limit);
      return;
    }
    const body = createFileRequestSchema.parse(req.body);
    res.status(201).json(await files.createFile(slugOf(req.params['slug']), userId, body));
  }),
);

filesRouter.post(
  '/rooms/:slug/files/:id/complete',
  asyncHandler(async (req, res) => {
    const file = await files.completeFile(
      slugOf(req.params['slug']),
      getAuth(req).userId,
      idOf(req.params['id']),
    );
    res.json({ file });
  }),
);

filesRouter.get(
  '/rooms/:slug/files',
  asyncHandler(async (req, res) => {
    res.json({ files: await files.listFiles(slugOf(req.params['slug']), getAuth(req).userId) });
  }),
);

filesRouter.get(
  '/rooms/:slug/files/:id/download',
  asyncHandler(async (req, res) => {
    const url = await files.downloadUrl(
      slugOf(req.params['slug']),
      getAuth(req).userId,
      idOf(req.params['id']),
    );
    res.json({ url });
  }),
);

filesRouter.delete(
  '/rooms/:slug/files/:id',
  asyncHandler(async (req, res) => {
    await files.deleteFile(slugOf(req.params['slug']), getAuth(req).userId, idOf(req.params['id']));
    res.status(204).end();
  }),
);
