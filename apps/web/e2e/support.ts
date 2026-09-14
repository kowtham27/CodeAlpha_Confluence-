import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { clearRateLimits } from './redis';

const MAILPIT = 'http://localhost:8025';
export const PASSWORD = 'correct horse battery staple';

/**
 * Waits that follow a password hash or check. Argon2id at 64 MB is deliberately
 * expensive (~300 ms), and on a memory-constrained Docker VM a single hash can
 * spike past 5 s while the VM pages in fresh memory. The UI default of 10 s is
 * right for everything else; these steps get headroom instead of weaker hashing.
 */
export const AUTH = { timeout: 30_000 };

/** A fresh address per run, so reruns never collide with earlier accounts. */
export function uniqueEmail(tag: string): string {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
}

interface MailpitSearch {
  messages: { ID: string }[];
}
interface MailpitMessage {
  Text: string;
}

/**
 * Reads a link out of the newest real email to `email` that points at `path`,
 * via Mailpit's API. Polls, because the API sends mail in the background.
 */
export async function emailLink(
  request: APIRequestContext,
  email: string,
  path: 'verify-email' | 'reset-password',
): Promise<string> {
  const pattern = new RegExp(`http\\S+/${path}#token=[A-Za-z0-9_-]{43}`);
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const search = await request.get(`${MAILPIT}/api/v1/search`, {
          params: { query: `to:"${email}"` },
        });
        // Mailpit returns newest first.
        for (const { ID } of ((await search.json()) as MailpitSearch).messages) {
          const res = await request.get(`${MAILPIT}/api/v1/message/${ID}`);
          link = ((await res.json()) as MailpitMessage).Text.match(pattern)?.[0];
          if (link) return link;
        }
        return undefined;
      },
      { message: `${path} email for ${email}` },
    )
    .toBeTruthy();
  if (!link) throw new Error('unreachable');
  return link;
}

export async function register(page: Page, name: string, email: string): Promise<void> {
  // A full run signs up more accounts than the 10-per-hour-per-IP limit; reset
  // just that counter. Every other limit stays in force during the suite.
  await clearRateLimits('rl:register-ip:*');
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible(AUTH);
  await expect(page.getByText(email)).toBeVisible();
}

export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Registers and verifies an account through the real UI and email. */
export async function createVerifiedAccount(
  page: Page,
  request: APIRequestContext,
  name: string,
  email: string,
): Promise<void> {
  await register(page, name, email);
  await page.goto(await emailLink(request, email, 'verify-email'));
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible(AUTH);
}
