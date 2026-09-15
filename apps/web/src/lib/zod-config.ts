import { z } from 'zod';

/**
 * Imported first (see main.tsx). Zod 4 compiles fast validators with
 * `new Function` when it can, and finds out by trying. Under the app's CSP
 * (no 'unsafe-eval') the attempt is blocked, and although Zod then falls back
 * safely, the blocked attempt is still a CSP violation report on every load.
 * Jitless mode never tries: the policy stays clean, and at this app's message
 * sizes the speed difference is immaterial.
 */
z.config({ jitless: true });
