import { expect, test } from '@playwright/test';
import { expectConnected, inboundStats, person, tiles, widestInbound } from './media';
import { enterRoom } from './support';

test('spec deliverable: A presents, B and C see it, A stops from the browser, camera returns', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');
  const cy = await person(browser, request, 'Cy');

  await ada.page.getByLabel('Start a new meeting').fill('Review');
  await ada.page.getByRole('button', { name: 'Start meeting' }).click();
  await expect(ada.page.getByRole('heading', { name: 'Review' })).toBeVisible();
  await enterRoom(ben.page, ada.page.url());
  await enterRoom(cy.page, ada.page.url());
  for (const p of [ada.page, ben.page, cy.page]) await expectConnected(p, 2);

  // Before: everyone receives 640px camera video.
  await expect.poll(() => widestInbound(ben.page)).toBeLessThanOrEqual(640);

  // Ada presents.
  await ada.page.getByRole('button', { name: 'Present your screen' }).click();
  await expect(
    ada.page.getByRole('heading', { name: 'You are presenting to everyone' }),
  ).toBeVisible();

  for (const viewer of [ben.page, cy.page]) {
    const stage = viewer.getByRole('region', { name: "Ada's presentation" });
    await expect(stage).toBeVisible();
    await expect(stage.getByText('Ada is presenting')).toBeVisible();
    // The screen really arrives: the stage renders it, at the screen's width.
    // On a loaded machine the encoder starts the new track small and ramps
    // up, hence the same headroom as the stats polls below.
    await expect
      .poll(() => stage.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), {
        timeout: 20_000,
      })
      .toBeGreaterThan(640);
    // Everyone else moves to the filmstrip.
    await expect(tiles(viewer)).toHaveCount(3);
  }
  // Spec: the swap is replaceTrack on the existing connection, so the
  // receiver sees the 1280px screen on the same, still-connected peer link.
  await expect.poll(() => widestInbound(ben.page), { timeout: 20_000 }).toBeGreaterThan(640);
  expect(await inboundStats(ben.page)).toHaveLength(2);

  // One presenter at a time: the others cannot start a second presentation.
  await expect(ben.page.getByRole('button', { name: 'Ada is presenting' })).toBeDisabled();

  // The screen's audio is mixed into Ada's outgoing audio: it keeps flowing.
  const audioBefore = (await inboundStats(ben.page)).map((s) => s.audioBytes);
  await ben.page.waitForTimeout(1_500);
  const audioAfter = (await inboundStats(ben.page)).map((s) => s.audioBytes);
  audioAfter.forEach((bytes, i) => expect(bytes).toBeGreaterThan(audioBefore[i] ?? 0));

  // Ada presses the browser's own "Stop sharing" button.
  await ada.page.evaluate(() =>
    (window as unknown as { __endScreenShare: () => void }).__endScreenShare(),
  );
  for (const viewer of [ben.page, cy.page]) {
    await expect(viewer.getByRole('region', { name: "Ada's presentation" })).toHaveCount(0);
  }
  await expect(ada.page.getByRole('button', { name: 'Present your screen' })).toBeVisible();
  // Camera returns: back to 640px, frames still flowing.
  await expect.poll(() => widestInbound(ben.page), { timeout: 20_000 }).toBeLessThanOrEqual(640);

  // The slot is free again: Ben presents, then leaves mid-presentation.
  await ben.page.getByRole('button', { name: 'Present your screen' }).click();
  await expect(cy.page.getByRole('region', { name: "Ben's presentation" })).toBeVisible();
  await ben.page.getByRole('button', { name: 'Leave call' }).click();
  // Leaving frees the slot for everyone.
  await expect(cy.page.getByRole('region', { name: "Ben's presentation" })).toHaveCount(0);
  await expect(cy.page.getByRole('button', { name: 'Present your screen' })).toBeEnabled();

  for (const p of [ada, ben, cy]) await p.context.close();
});

test('the presenter can stop from the app too', async ({ browser, request }) => {
  test.setTimeout(240_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');
  await ada.page.getByLabel('Start a new meeting').fill('Quick');
  await ada.page.getByRole('button', { name: 'Start meeting' }).click();
  await expect(ada.page.getByRole('heading', { name: 'Quick' })).toBeVisible();
  await enterRoom(ben.page, ada.page.url());
  await expectConnected(ben.page, 1);

  await ada.page.getByRole('button', { name: 'Present your screen' }).click();
  await expect(ben.page.getByRole('region', { name: "Ada's presentation" })).toBeVisible();

  await ada.page.getByRole('button', { name: 'Stop presenting' }).first().click();
  await expect(ben.page.getByRole('region', { name: "Ada's presentation" })).toHaveCount(0);
  await expect.poll(() => widestInbound(ben.page), { timeout: 20_000 }).toBeLessThanOrEqual(640);

  await ada.context.close();
  await ben.context.close();
});
