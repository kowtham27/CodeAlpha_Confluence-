import { expect, test, type Page } from '@playwright/test';
import { person } from './media';
import { enterRoom, joinFromLobby } from './support';

/** Spec Phase 7: end-to-end encrypted chat, and safety codes to verify keys. */

const chatPanel = (page: Page) => page.getByRole('region', { name: 'Chat' });
const log = (page: Page) => chatPanel(page).getByRole('log', { name: 'Messages' });

async function openChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Chat/ }).click();
  await expect(chatPanel(page)).toBeVisible();
  await expect(chatPanel(page).getByText('End-to-end encrypted.')).toBeVisible({ timeout: 30_000 });
}

async function say(page: Page, text: string): Promise<void> {
  await chatPanel(page).getByRole('textbox', { name: 'Message' }).fill(text);
  await chatPanel(page).getByRole('textbox', { name: 'Message' }).press('Enter');
}

async function codes(page: Page): Promise<Map<string, string>> {
  await chatPanel(page).getByText('Compare safety codes').click();
  const list = chatPanel(page).getByRole('list', { name: 'Safety codes' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  const out = new Map<string, string>();
  for (const item of await list.getByRole('listitem').all()) {
    const [who = '', code = ''] = (await item.innerText()).split('\n');
    out.set(who.trim(), code.trim());
  }
  return out;
}

test('encrypted chat: live, kept across reloads, shown as text, verifiable', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');

  await ada.page.getByLabel('Start a new meeting').fill('Talk');
  await ada.page.getByRole('button', { name: 'Start meeting' }).click();
  await expect(ada.page.getByRole('heading', { name: 'Talk' })).toBeVisible();
  await enterRoom(ben.page, ada.page.url());

  await openChat(ada.page);
  await expect(log(ada.page).getByText('No messages yet. Say hello.')).toBeVisible();
  await say(ada.page, 'Hello Ben, can you hear me?');
  await expect(log(ada.page).getByText('Hello Ben, can you hear me?')).toBeVisible();

  // Ben was not looking: the header counts it.
  await expect(ben.page.getByRole('button', { name: 'Chat 1 unread' })).toBeVisible({
    timeout: 30_000,
  });
  await openChat(ben.page);
  const fromAda = log(ben.page).getByRole('listitem').filter({ hasText: 'Hello Ben' });
  await expect(fromAda).toContainText('Ada');
  await expect(ben.page.getByRole('button', { name: 'Chat', exact: true })).toBeVisible();

  await say(ben.page, 'Loud and clear.');
  await expect(log(ada.page).getByText('Loud and clear.')).toBeVisible();

  // Text is text: markup is shown, never run or rendered.
  await say(ben.page, '<img src=x onerror="document.title=1">');
  await expect(log(ada.page).getByText('<img src=x onerror="document.title=1">')).toBeVisible();
  await expect(log(ada.page).locator('img')).toHaveCount(0);

  // History survives a reload: fetched as ciphertext, decrypted here.
  await ada.page.reload();
  await joinFromLobby(ada.page);
  await openChat(ada.page);
  await expect(log(ada.page).getByText('Hello Ben, can you hear me?')).toBeVisible();
  await expect(log(ada.page).getByText('Loud and clear.')).toBeVisible();

  // Safety codes: what Ada sees as her own code is what Ben sees for Ada,
  // and the other way round. A substituted key would break the match.
  const adaSees = await codes(ada.page);
  const benSees = await codes(ben.page);
  expect(adaSees.get('Your code')).toMatch(/^\d{5}( \d{5}){5}$/);
  expect(benSees.get('Ada')).toBe(adaSees.get('Your code'));
  expect(adaSees.get('Ben')).toBe(benSees.get('Your code'));
  expect(adaSees.get('Your code')).not.toBe(benSees.get('Your code'));

  for (const p of [ada, ben]) await p.context.close();
});
