import { expect, test } from '@playwright/test';
import { expectConnected, inboundStats, person, tiles } from './media';
import { joinFromLobby } from './support';

/** Spec Phase 8: lobby, shortcuts, quality, themes, reconnection. */

test('the lobby: choose what starts off, and the call honours it', async ({ browser, request }) => {
  test.setTimeout(240_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');
  await ada.page.getByLabel('Start a new meeting').fill('Lobby');
  await ada.page.getByRole('button', { name: 'Create room' }).click();
  // The creator goes straight in.
  await expect(tiles(ada.page)).toHaveCount(1);

  await ben.page.goto(ada.page.url());
  await expect(ben.page.getByRole('heading', { name: 'Lobby' })).toBeVisible();
  await expect(ben.page.getByText('Hosted by Ada · 1 person is here')).toBeVisible();
  // Nothing is shared from the lobby: Ada still sees only herself.
  await expect(tiles(ada.page)).toHaveCount(1);
  await expect
    .poll(() =>
      ben.page.getByLabel('Your camera preview').evaluate((v: HTMLVideoElement) => v.videoWidth),
    )
    .toBeGreaterThan(0);

  await ben.page.getByRole('button', { name: 'Join with microphone off' }).click();
  await ben.page.getByRole('button', { name: 'Join with camera off' }).click();
  await joinFromLobby(ben.page);

  await expect(ben.page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
  await expect(ben.page.getByRole('button', { name: 'Turn on camera' })).toBeVisible();
  const benOnAda = tiles(ada.page).filter({ hasText: 'Ben' });
  await expect(benOnAda.getByRole('img', { name: 'Microphone off' })).toBeVisible();
  await expect(benOnAda.locator('video')).toHaveClass(/opacity-0/);

  // Connected peers show how the link is doing.
  await expectConnected(ada.page, 1);
  await expect(benOnAda.getByRole('img', { name: /^Connection: (good|fair)$/ })).toBeVisible({
    timeout: 15_000,
  });

  for (const p of [ada, ben]) await p.context.close();
});

test('keyboard shortcuts in a call, and their help', async ({ browser, request }) => {
  test.setTimeout(180_000);
  const { context, page } = await person(browser, request, 'Ada');
  await page.getByLabel('Start a new meeting').fill('Keys');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(page.getByRole('button', { name: 'Turn off microphone' })).toBeVisible();

  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Turn on microphone' })).toBeVisible();
  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Turn off microphone' })).toBeVisible();
  await page.keyboard.press('v');
  await expect(page.getByRole('button', { name: 'Turn on camera' })).toBeVisible();

  // Typing is typing, not shortcuts.
  await page.keyboard.press('c');
  const chat = page.getByRole('region', { name: 'Chat' });
  await expect(chat).toBeVisible();
  await expect(chat.getByText('End-to-end encrypted.')).toBeVisible({ timeout: 30_000 });
  await chat.getByRole('textbox', { name: 'Message' }).fill('mmm video');
  await expect(page.getByRole('button', { name: 'Turn on camera' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off microphone' })).toBeVisible();

  await page.getByRole('heading', { name: 'Keys' }).click(); // focus out of the text box
  await page.keyboard.press('b');
  await expect(page.getByRole('region', { name: 'Whiteboard' })).toBeVisible();

  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(help.getByRole('cell', { name: 'Turn the microphone on or off' })).toBeVisible();
  // Shortcuts are off while the dialog is open; Escape closes it.
  await page.keyboard.press('m');
  await expect(page.getByRole('button', { name: 'Turn off microphone' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  await context.close();
});

test('theme: follow the system, or choose, and the choice sticks', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const { context, page } = await person(browser, request, 'Ada');
  const theme = () => page.evaluate(() => document.documentElement.dataset['theme'] ?? 'system');
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  expect(await theme()).toBe('system');
  const light = await background();

  await page.getByRole('radio', { name: 'Dark theme' }).click();
  expect(await theme()).toBe('dark');
  expect(await background()).not.toBe(light);

  await page.reload();
  await expect(page.getByRole('radio', { name: 'Dark theme' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(await theme()).toBe('dark');

  await page.getByRole('radio', { name: 'System theme' }).click();
  expect(await theme()).toBe('system');
  expect(await background()).toBe(light);

  await context.close();
});

test('reconnection: a dropped connection rejoins by itself and media flows again', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');
  await ada.page.getByLabel('Start a new meeting').fill('Flaky wifi');
  await ada.page.getByRole('button', { name: 'Create room' }).click();
  await expect(tiles(ada.page)).toHaveCount(1);
  await ben.page.goto(ada.page.url());
  await joinFromLobby(ben.page);
  await expectConnected(ada.page, 1);
  await expectConnected(ben.page, 1);

  await ben.context.setOffline(true);
  await expect(ben.page.getByText('Connection lost. Reconnecting')).toBeVisible({
    timeout: 60_000,
  });
  await ben.context.setOffline(false);

  // Ben is back without touching anything: same seat, fresh connections.
  await expect(ben.page.getByText('Connection lost. Reconnecting')).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(tiles(ada.page)).toHaveCount(2);
  await expect(tiles(ben.page)).toHaveCount(2);
  await expectConnected(ada.page, 1);
  await expectConnected(ben.page, 1);
  const before = (await inboundStats(ada.page))[0]?.videoFrames ?? 0;
  await expect
    .poll(async () => (await inboundStats(ada.page))[0]?.videoFrames ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(before);

  for (const p of [ada, ben]) await p.context.close();
});
