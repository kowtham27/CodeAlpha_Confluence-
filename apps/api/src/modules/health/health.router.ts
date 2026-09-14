import { Router } from 'express';
import { healthResponseSchema } from '@confluence/shared';
import { asyncHandler } from '../../middleware/async-handler.js';
import { getHealth } from './health.service.js';

const VERSION = process.env['npm_package_version'] ?? '0.1.0';

export const healthRouter: Router = Router();

/**
 * Liveness: is the process running at all? Never touches dependencies, so a
 * database outage does not get the container killed and restarted pointlessly.
 */
healthRouter.get('/livez', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

/**
 * Readiness: should this instance receive traffic? Returns 503 when a
 * dependency is down, with the per-dependency detail in the body either way.
 */
healthRouter.get(
  '/healthz',
  asyncHandler(async (_req, res) => {
    const health = await getHealth(VERSION);
    // Validate our own response against the shared schema: if the contract and
    // the implementation drift, this fails loudly in dev rather than silently
    // breaking the client's inferred types.
    const body = healthResponseSchema.parse(health);
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  }),
);
