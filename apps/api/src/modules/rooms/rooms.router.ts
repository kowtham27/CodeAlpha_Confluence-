import { Router } from 'express';
import {
  createRoomRequestSchema,
  roomSlugSchema,
  updateRoomRequestSchema,
  type RoomSummary,
} from '@confluence/shared';
import { AUDIT_ACTIONS, audit, requestContext } from '../../lib/audit.js';
import { asyncHandler } from '../../middleware/async-handler.js';
import { getAuth, requireAuth } from '../../middleware/require-auth.js';
import * as rooms from './rooms.service.js';

export const roomsRouter: Router = Router();

// Every room route needs a signed-in user.
roomsRouter.use(requireAuth);

/** Validates the :slug path segment before it reaches a query. */
function slugParam(value: unknown): string {
  return roomSlugSchema.parse(value);
}

roomsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = createRoomRequestSchema.parse(req.body);
    const { userId } = getAuth(req);
    const room = await rooms.createRoom(userId, name);
    audit(AUDIT_ACTIONS.ROOM_CREATED, requestContext(req), {
      userId,
      metadata: { slug: room.slug },
    });
    res.status(201).json({ room } satisfies { room: RoomSummary });
  }),
);

roomsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ rooms: await rooms.listRooms(getAuth(req).userId) });
  }),
);

roomsRouter.get(
  '/:slug',
  asyncHandler(async (req, res) => {
    const room = await rooms.getRoom(slugParam(req.params['slug']), getAuth(req).userId);
    res.json({ room });
  }),
);

roomsRouter.patch(
  '/:slug',
  asyncHandler(async (req, res) => {
    const patch = updateRoomRequestSchema.parse(req.body);
    const room = await rooms.updateRoom(slugParam(req.params['slug']), getAuth(req).userId, patch);
    res.json({ room });
  }),
);

roomsRouter.post(
  '/:slug/end',
  asyncHandler(async (req, res) => {
    const slug = slugParam(req.params['slug']);
    const { userId } = getAuth(req);
    await rooms.endRoom(slug, userId);
    audit(AUDIT_ACTIONS.ROOM_ENDED, requestContext(req), { userId, metadata: { slug } });
    res.status(204).end();
  }),
);
