import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const MAILPIT = 'http://localhost:8025';
const PASSWORD = 'correct horse battery staple';

/**
 * Waits that follow a password hash or check. Argon2id at 64 MB is deliberately
 * expensive (~300 ms), and on a memory-constrained Docker VM a single hash can
 * spike past 5 s while the VM pages in fresh memory. The UI default of 10 s is
 * right for everything else; these steps get headroom instead of weaker hashing.
 */
const AUTH = { timeout: 30_000 };

/** A fresh address per run, so reruns never collide with earlier accounts. */
function uniqueEmail(tag: string): string {
  return `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e4)}@example.com`;
}

interface MailpitSearch {
  messages: { ID: string }[];
}
interface MailpitMessage {
  Text: string;
}

/** Reads the verification link out of the real email, via Mailpit's API. */
async function verificationLink(request: APIRequestContext, email: string): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const search = await request.get(`${MAILPIT}/api/v1/search`, {
          params: { query: `to:"${email}" subject:"Verify"` },
        });
        const { messages } = (await search.json()) as MailpitSearch;
        const id = messages[0]?.ID;
        if (!id) return undefined;
        const message = (await (
          await request.get(`${MAILPIT}/api/v1/message/${id}`)
        ).json()) as MailpitMessage;
        link = message.Text.match(/http\S+\/verify-email#token=[A-Za-z0-9_-]{43}/)?.[0];
        return link;
      },
      { message: `verification email for ${email}` },
    )
    .toBeTruthy();
  if (!link) throw new Error('unreachable');
  return link;
}

async function register(page: Page, name: string, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible(AUTH);
  await expect(page.getByText(email)).toBeVisible();
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('sign up, verify by email, stay signed in across reload, sign out everywhere', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('e2e');

  // 1. Sign up, then follow the link from the real email.
  await register(page, 'Kowtham', email);
  await page.goto(await verificationLink(request, email));
  await expect(page.getByRole('heading', { name: 'Email verified' })).toBeVisible();
  // The token is stripped from the address bar as soon as it is read.
  expect(page.url()).not.toContain('token=');

  // 2. Sign in, with the email carried over from the verification page.
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await expect(page.getByLabel('Email')).toHaveValue(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Hi, Kowtham' })).toBeVisible(AUTH);
  await expect(page.getByText('Connected')).toBeVisible();

  // 3. Spec deliverable: stay signed in across a full reload. The access
  //    token was only in memory; the httpOnly cookie restores the session.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Hi, Kowtham' })).toBeVisible(AUTH);
  const tokenInStorage = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }).includes('eyJ'),
  );
  expect(tokenInStorage).toBe(false);

  // 4. A second device signs in to the same account.
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await signIn(phone, email);
  await expect(phone.getByRole('heading', { name: 'Hi, Kowtham' })).toBeVisible(AUTH);
  await expect(phone.getByText('Connected')).toBeVisible();

  // 5. Spec deliverable: sign out everywhere.
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('You signed out of every device.')).toBeVisible();

  //    The other device is thrown out in real time, with no action on its part.
  await expect(phone.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(phone.getByText('You were signed out from another device.')).toBeVisible();

  //    And a reload does not bring either session back.
  for (const p of [page, phone]) {
    await p.reload();
    await expect(p.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  }
  await phoneContext.close();
});

test('an unverified account cannot sign in and can request a new link', async ({ page }) => {
  const email = uniqueEmail('unverified');
  await register(page, 'Ada', email);

  await signIn(page, email);
  await expect(page.getByText('Verify your email before signing in.')).toBeVisible(AUTH);
  await page.getByRole('button', { name: 'Resend verification email' }).click();
  await expect(page.getByText('a new link is on its way')).toBeVisible();
});

test('a wrong password gets a generic error and clears the field', async ({ page }) => {
  await signIn(page, uniqueEmail('nobody'));
  await expect(page.getByText('Incorrect email or password.')).toBeVisible(AUTH);
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
});

test('signed-out visitors are sent to sign in', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
