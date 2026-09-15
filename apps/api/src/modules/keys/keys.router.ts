import { Router } from 'express';
import {
  grantRoomKeyRequestSchema,
  initRoomKeyRequestSchema,
  roomSlugSchema,
  setUserKeysRequestSchema,
} from '@confluence/shared';
import { asyncHandler } from '../../middleware/async-handler.js';
import { getAuth, requireAuth } from '../../middleware/require-auth.js';
import * as keys from './keys.service.js';

export const keysRouter: Router = Router();

const slugOf = (value: unknown): string => roomSlugSchema.parse(value);

// ---- the caller's own key pair -------------------------------------------------

keysRouter.get(
  '/me/keys',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await keys.getUserKeys(getAuth(req).userId));
  }),
);

keysRouter.put(
  '/me/keys',
  requireAuth,
  asyncHandler(async (req, res) => {
    await keys.setUserKeys(getAuth(req).userId, setUserKeysRequestSchema.parse(req.body));
    res.status(204).end();
  }),
);

// ---- a room's key --------------------------------------------------------------

keysRouter.get(
  '/rooms/:slug/key',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await keys.getRoomKey(slugOf(req.params['slug']), getAuth(req).userId));
  }),
);

keysRouter.put(
  '/rooms/:slug/key',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = initRoomKeyRequestSchema.parse(req.body);
    await keys.initRoomKey(slugOf(req.params['slug']), getAuth(req).userId, body);
    res.status(204).end();
  }),
);

keysRouter.get(
  '/rooms/:slug/key/requests',
  requireAuth,
  asyncHandler(async (req, res) => {
    const requests = await keys.keyRequests(slugOf(req.params['slug']), getAuth(req).userId);
    res.json({ requests });
  }),
);

keysRouter.post(
  '/rooms/:slug/key/grants',
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = grantRoomKeyRequestSchema.parse(req.body);
    await keys.grantRoomKey(slugOf(req.params['slug']), getAuth(req).userId, body);
    res.status(204).end();
  }),
);

keysRouter.delete(
  '/rooms/:slug/key/mine',
  requireAuth,
  asyncHandler(async (req, res) => {
    await keys.clearMyRoomKey(slugOf(req.params['slug']), getAuth(req).userId);
    res.status(204).end();
  }),
);
