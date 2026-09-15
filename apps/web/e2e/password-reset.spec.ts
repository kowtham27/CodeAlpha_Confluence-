import { expect, test } from '@playwright/test';
import {
  AUTH,
  PASSWORD,
  createVerifiedAccount,
  emailLink,
  expectRealtime,
  signIn,
  uniqueEmail,
} from './support';

const NEW_PASSWORD = 'a completely different passphrase';

test('forgot password: email link, new password, every device signed out', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('reset');
  await createVerifiedAccount(page, request, 'Kowtham', email);

  // Another device is signed in with the old password.
  const phoneContext = await browser.newContext();
  const phone = await phoneContext.newPage();
  await signIn(phone, email);
  await expect(phone.getByRole('heading', { name: 'Hi, Kowtham' })).toBeVisible(AUTH);
  await expectRealtime(phone);

  // "Forgot password?" carries the typed email across.
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await expect(page.getByLabel('Email')).toHaveValue(email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('a link to reset the password is on its way')).toBeVisible();

  // Follow the link from the real email.
  const resetLink = await emailLink(request, email, 'reset-password');
  await page.goto(resetLink);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  expect(page.url()).not.toContain('token=');

  // The policy is enforced on the new password.
  await page.getByLabel('New password').fill('short');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText(/at least 12 characters/i).last()).toBeVisible(AUTH);

  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('Password updated and every device signed out.')).toBeVisible(AUTH);
  await expect(page.getByLabel('Email')).toHaveValue(email);

  // The other device was thrown out in real time.
  await expect(phone.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(phone.getByText('You were signed out from another device.')).toBeVisible();
  await phoneContext.close();

  // The old password is dead; the new one works.
  await signIn(page, email, PASSWORD);
  await expect(page.getByText('Incorrect email or password.')).toBeVisible(AUTH);
  await signIn(page, email, NEW_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Hi, Kowtham' })).toBeVisible(AUTH);

  // And the same link cannot be used a second time.
  await page.goto(resetLink);
  await page.getByLabel('New password').fill('yet another new passphrase');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible(AUTH);
});

test('a used or bogus reset link offers to send a new one', async ({ page }) => {
  await page.goto(`/reset-password#token=${'A'.repeat(43)}`);
  await page.getByLabel('New password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByRole('heading', { name: 'Link not valid' })).toBeVisible(AUTH);
  await page.getByRole('link', { name: 'Send a new reset link' }).click();
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
});
