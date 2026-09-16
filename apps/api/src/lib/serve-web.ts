import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { env } from '../config/env.js';

/**
 * Anything the API itself answers. The single-page app owns every other path
 * (/login, /r/<slug>, ...), so those fall back to index.html; an unknown path
 * under one of these stays a JSON 404 from the API's own handler.
 */
const API_PATHS = /^\/(auth|rooms|me|healthz|livez|socket\.io)(\/|$)/;

/**
 * The same policy nginx sends in front of the static build
 * (infra/security-headers.conf.template), for the deployment where the API
 * serves the web app itself and the two share one origin. Same origin means
 * connect-src needs no API entry: 'self' covers the API and its WebSocket.
 */
function documentHeaders(res: Response): void {
  const storage = new URL(env.S3_PUBLIC_ENDPOINT).origin;
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // WebAssembly: libsodium compiles its module at run time.
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self'",
      `connect-src 'self' ${storage}`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader(
    'Permissions-Policy',
    'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // helmet's API default is same-site; the page loads its own assets only.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

/**
 * Serves the built web app next to the API, on one origin. Used by the
 * single-container deployment; with nginx in front (pnpm stack:up) the
 * directory is not set and this does nothing.
 */
export function serveWebApp(app: Express, dir: string): void {
  const index = join(dir, 'index.html');

  app.use(
    express.static(dir, {
      index: false,
      // Vite fingerprints every asset, so they can be cached forever; the
      // entry document must never be, or a deploy goes unnoticed.
      setHeaders: (res, path) => {
        documentHeaders(res);
        if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else if (path.includes('/assets/'))
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );

  app.get(/.*/, (req: Request, res: Response, next: NextFunction) => {
    if (API_PATHS.test(req.path) || !req.accepts('html')) {
      next();
      return;
    }
    documentHeaders(res);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html');
    createReadStream(index).pipe(res);
  });
}
