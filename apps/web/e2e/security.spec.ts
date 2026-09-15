import { expect, test } from '@playwright/test';
import { AUTH, createVerifiedAccount, signIn, uniqueEmail } from './support';

/**
 * Spec Phase 7: the production web app is served with a strict CSP, and the
 * whole app, WebAssembly crypto included, runs under it without a single
 * violation. The Vite dev server sends no CSP (React's dev tooling needs
 * inline script), so this runs against the production build: `pnpm stack:up`.
 */

const RECORD_VIOLATIONS = `
  window.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI);
  });
`;

test('production CSP is strict, and the app runs under it without violations', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await context.addInitScript(RECORD_VIOLATIONS);
  const page = await context.newPage();

  const response = await page.goto('/login');
  const headers = response?.headers() ?? {};
  const csp = headers['content-security-policy'];
  test.skip(!csp, 'The dev server sends no CSP; run against the production build (pnpm stack:up).');

  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'none'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain('unsafe-inline');
  expect(headers['permissions-policy']).toContain('camera=(self)');
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-content-type-options']).toBe('nosniff');

  // Fingerprinted assets carry the same headers (nginx does not inherit
  // add_header into locations that set their own).
  const script = await page.locator('script[type="module"]').first().getAttribute('src');
  const asset = await request.get(script ?? '/');
  expect(asset.headers()['content-security-policy']).toBe(csp);

  // Everything that could trip a CSP: WebAssembly (Argon2id at sign-in),
  // the socket, the API, and encrypting a chat message.
  const email = uniqueEmail('csp');
  await createVerifiedAccount(page, request, 'Casey', email);
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Hi, Casey' })).toBeVisible(AUTH);
  await page.getByLabel('Start a new meeting').fill('Headers');
  await page.getByRole('button', { name: 'Create room' }).click();
  await page.getByRole('button', { name: /^Chat/ }).click();
  const chat = page.getByRole('region', { name: 'Chat' });
  await expect(chat.getByText('End-to-end encrypted.')).toBeVisible({ timeout: 30_000 });
  await chat.getByRole('textbox', { name: 'Message' }).fill('Under a strict CSP');
  await chat.getByRole('textbox', { name: 'Message' }).press('Enter');
  await expect(chat.getByRole('log').getByText('Under a strict CSP')).toBeVisible();

  const violations = await page.evaluate(
    () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
  );
  expect(violations).toEqual([]);
  await context.close();
});
