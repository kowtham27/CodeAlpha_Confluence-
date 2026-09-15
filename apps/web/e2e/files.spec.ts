import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { expectConnected, person } from './media';
import { enterRoom, joinFromLobby, PASSWORD } from './support';

/**
 * Spec Phase 5: file sharing, both ways. Persisted files are encrypted in
 * the browser with a room key that the server never sees; direct transfers
 * go browser to browser over the call's data channels.
 */

const panel = (page: Page) => page.getByRole('region', { name: 'Files' });
const sharedList = (page: Page) => page.getByRole('list', { name: 'Shared files' });

async function openFiles(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Files/ }).click();
  await expect(panel(page)).toBeVisible();
}

async function expectEncrypted(page: Page): Promise<void> {
  await expect(panel(page).getByText('End-to-end encrypted.')).toBeVisible({ timeout: 30_000 });
}

/** Clicks `trigger` and returns the saved download's text. */
async function downloadText(page: Page, trigger: () => Promise<void>): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = await download.path();
  return readFile(path, 'utf8');
}

test('encrypted files: shared, granted, restored after reload, downloaded, deleted', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');

  await ada.page.getByLabel('Start a new meeting').fill('Handover');
  await ada.page.getByRole('button', { name: 'Start meeting' }).click();
  await expect(ada.page.getByRole('heading', { name: 'Handover' })).toBeVisible();
  await openFiles(ada.page);
  // The first person in creates the room key.
  await expectEncrypted(ada.page);

  // Ben joins; Ada's browser seals the room key to him without anyone acting.
  await enterRoom(ben.page, ada.page.url());
  await openFiles(ben.page);
  await expectEncrypted(ben.page);

  const secret = `Minutes: ship on Friday. ${Date.now()}`;
  await panel(ada.page)
    .getByTestId('file-input')
    .setInputFiles({ name: 'minutes.txt', mimeType: 'text/plain', buffer: Buffer.from(secret) });
  await expect(sharedList(ada.page).getByText('minutes.txt')).toBeVisible({ timeout: 30_000 });

  // Announced live to Ben, name decrypted in his browser.
  await expect(sharedList(ben.page).getByText('minutes.txt')).toBeVisible();
  await expect(sharedList(ben.page).getByText(/Ada · expires in 7 days/)).toBeVisible();
  const saved = await downloadText(ben.page, () =>
    ben.page.getByRole('button', { name: 'Download minutes.txt' }).click(),
  );
  expect(saved).toBe(secret);

  // Refused by content, before anything is encrypted or sent.
  await panel(ada.page)
    .getByTestId('file-input')
    .setInputFiles({
      name: 'invite.html',
      mimeType: 'text/html',
      buffer: Buffer.from('<!doctype html><script>alert(1)</script>'),
    });
  await expect(
    panel(ada.page).getByText('invite.html: This kind of file cannot be shared.'),
  ).toBeVisible();

  // A reload restores the session without a password: the keys come back from
  // this device, and the list decrypts again without asking.
  await ben.page.reload();
  await joinFromLobby(ben.page);
  await openFiles(ben.page);
  await expectEncrypted(ben.page);
  await expect(sharedList(ben.page).getByText('minutes.txt')).toBeVisible();

  // With the device copy gone, the password unlocks the keys again.
  await ben.page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('confluence-keys');
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      }),
  );
  await ben.page.reload();
  await joinFromLobby(ben.page);
  await openFiles(ben.page);
  await expect(panel(ben.page).getByText('Enter your password to unlock')).toBeVisible();
  await panel(ben.page).getByLabel('Password', { exact: true }).fill(PASSWORD);
  await panel(ben.page).getByRole('button', { name: 'Unlock' }).click();
  await expectEncrypted(ben.page);
  await expect(sharedList(ben.page).getByText('minutes.txt')).toBeVisible();

  // Only the uploader or host may delete; it disappears for everyone.
  await expect(ben.page.getByRole('button', { name: 'Delete minutes.txt' })).toHaveCount(0);
  await ada.page.getByRole('button', { name: 'Delete minutes.txt' }).click();
  await panel(ada.page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(sharedList(ben.page).getByText('minutes.txt')).toHaveCount(0);
  await expect(panel(ben.page).getByText('Nothing shared yet.')).toBeVisible();

  for (const p of [ada, ben]) await p.context.close();
});

test('direct transfer: browser to browser over the call, never stored', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');

  await ada.page.getByLabel('Start a new meeting').fill('Direct');
  await ada.page.getByRole('button', { name: 'Start meeting' }).click();
  await expect(ada.page.getByRole('heading', { name: 'Direct' })).toBeVisible();
  await enterRoom(ben.page, ada.page.url());
  await expectConnected(ada.page, 1);
  await expectConnected(ben.page, 1);

  await openFiles(ada.page);
  await ada.page.getByRole('radio', { name: /Send directly/ }).check();
  await expect(panel(ada.page).getByText('Only people in the call right now.')).toBeVisible();

  // Big enough to need many chunks and the backpressure path.
  const body = 'direct transfer line\n'.repeat(120_000); // ~2.5 MB
  await panel(ada.page)
    .getByTestId('file-input')
    .setInputFiles({ name: 'log.txt', mimeType: 'text/plain', buffer: Buffer.from(body) });

  // Ben was not looking at files: the header counts what arrived.
  await expect(ben.page.getByRole('button', { name: /^Files\s*1 new/ })).toBeVisible({
    timeout: 30_000,
  });
  await openFiles(ben.page);
  const row = panel(ben.page).getByTestId('direct-transfer').filter({ hasText: 'log.txt' });
  await expect(row.getByText('Received')).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText('from Ada');
  await expect(
    panel(ada.page).getByTestId('direct-transfer').filter({ hasText: 'log.txt' }).getByText('Sent'),
  ).toBeVisible();

  const saved = await downloadText(ben.page, () =>
    row.getByRole('button', { name: 'Save log.txt' }).click(),
  );
  expect(saved).toBe(body);

  // Nothing was uploaded to the room.
  await ben.page.getByRole('radio', { name: /Keep in this room/ }).check();
  await expect(panel(ben.page).getByText('Nothing shared yet.')).toBeVisible({ timeout: 30_000 });

  for (const p of [ada, ben]) await p.context.close();
});
