import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { prisma } from './lib/prisma.js';
import { redis } from './lib/redis.js';
import { WEB_ORIGIN } from '../test/helpers.js';

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
  await redis.quit();
});

describe('security headers (spec Phase 7)', () => {
  it('lets a JSON response load or run nothing, and says so strictly', async () => {
    const res = await request(app).get('/livez').expect(200);
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none'",
    );
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('answers CORS only for the web origin, and lets browsers cache the preflight', async () => {
    const ok = await request(app)
      .options('/me/keys')
      .set('Origin', WEB_ORIGIN)
      .set('Access-Control-Request-Method', 'PUT')
      .expect(204);
    expect(ok.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(ok.headers['access-control-allow-methods']).toContain('PUT');
    expect(ok.headers['access-control-max-age']).toBe('600');

    const evil = await request(app)
      .options('/me/keys')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'PUT');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
