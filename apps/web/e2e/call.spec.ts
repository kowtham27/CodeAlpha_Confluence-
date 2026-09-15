import { expect, test } from '@playwright/test';
import { inboundStats, person, tiles } from './media';
import { enterRoom } from './support';

test('spec deliverable: three browsers, two-way audio and video between every pair', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');
  const cy = await person(browser, request, 'Cy');

  await ada.page.getByLabel('Start a new meeting').fill('Standup');
  await ada.page.getByRole('button', { name: 'Create room' }).click();
  await expect(ada.page.getByRole('heading', { name: 'Standup' })).toBeVisible();
  const link = ada.page.url();
  await enterRoom(ben.page, link);
  await enterRoom(cy.page, link);

  const everyone = [ada.page, ben.page, cy.page];
  for (const page of everyone) await expect(tiles(page)).toHaveCount(3);

  // Full mesh: every page holds two connected peer connections...
  for (const page of everyone) {
    await expect.poll(async () => (await inboundStats(page)).length, { timeout: 30_000 }).toBe(2);
  }

  // ...and real media is arriving on both, and keeps arriving.
  for (const page of everyone) {
    const first = await inboundStats(page);
    await page.waitForTimeout(2_000);
    const second = await inboundStats(page);
    expect(second).toHaveLength(2);
    second.forEach((now, i) => {
      const before = first[i] ?? { audioBytes: 0, videoFrames: 0 };
      expect(now.audioBytes, 'audio bytes still increasing').toBeGreaterThan(before.audioBytes);
      expect(now.videoFrames, 'video frames still being decoded').toBeGreaterThan(
        before.videoFrames,
      );
    });
  }

  // Remote video actually renders in the tiles.
  const benSeesAda = tiles(ben.page).filter({ hasText: 'Ada' }).locator('video');
  await expect
    .poll(() => benSeesAda.evaluate((v: HTMLVideoElement) => v.videoWidth))
    .toBeGreaterThan(0);

  // Mute: everyone else sees the indicator.
  await ada.page.getByRole('button', { name: 'Turn off microphone' }).click();
  for (const page of [ben.page, cy.page]) {
    await expect(
      tiles(page).filter({ hasText: 'Ada' }).getByRole('img', { name: 'Microphone off' }),
    ).toBeVisible();
  }
  await ada.page.getByRole('button', { name: 'Turn on microphone' }).click();
  await expect(
    tiles(ben.page).filter({ hasText: 'Ada' }).getByRole('img', { name: 'Microphone off' }),
  ).toHaveCount(0);

  // Camera off: the others see Ada's initials instead of video.
  await ada.page.getByRole('button', { name: 'Turn off camera' }).click();
  await expect(tiles(cy.page).filter({ hasText: 'Ada' }).locator('video')).toHaveClass(/opacity-0/);

  // Leaving tears the connections down on both remaining sides.
  await cy.page.getByRole('button', { name: 'Leave call' }).click();
  await expect(cy.page.getByRole('heading', { name: 'Hi, Cy' })).toBeVisible();
  for (const page of [ada.page, ben.page]) {
    await expect(tiles(page)).toHaveCount(2);
    await expect.poll(async () => (await inboundStats(page)).length).toBe(1);
  }

  for (const p of [ada, ben, cy]) await p.context.close();
});

test('the active speaker is highlighted', async ({ browser, request }) => {
  test.setTimeout(240_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');
  await ada.page.getByLabel('Start a new meeting').fill('Talk');
  await ada.page.getByRole('button', { name: 'Create room' }).click();
  await expect(ada.page.getByRole('heading', { name: 'Talk' })).toBeVisible();
  await enterRoom(ben.page, ada.page.url());
  await expect(tiles(ben.page)).toHaveCount(2);

  // Chromium's fake microphone plays a tone, so someone is always "speaking".
  await expect(ben.page.locator('li[data-speaking]')).toHaveCount(1, { timeout: 20_000 });

  // Muting stops the tone going out; with both muted, nobody is highlighted.
  await ada.page.getByRole('button', { name: 'Turn off microphone' }).click();
  await ben.page.getByRole('button', { name: 'Turn off microphone' }).click();
  await expect(ben.page.locator('li[data-speaking]')).toHaveCount(0, { timeout: 10_000 });

  await ada.context.close();
  await ben.context.close();
});
