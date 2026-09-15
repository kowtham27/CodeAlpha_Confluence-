import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { person, tiles } from './media';

/**
 * Spec Phase 8: accessibility. axe-core checks every main screen against
 * WCAG 2.1 A and AA, in both themes (colour contrast differs per palette).
 * Video is excluded: a live camera frame has no text to contrast against.
 */

async function audit(page: Page, where: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('video')
    .analyze();
  const problems = results.violations.map(
    (v) =>
      `${v.id} [${v.impact ?? 'n/a'}] ${v.help}: ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
  expect(problems, `accessibility problems on ${where}`).toEqual([]);
}

test('signed-out pages', async ({ page }) => {
  for (const path of ['/login', '/register', '/forgot-password']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await audit(page, path);
  }
});

test('home, lobby and a call with every panel, in light and dark', async ({ browser, request }) => {
  test.setTimeout(300_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');

  for (const theme of ['Light theme', 'Dark theme'] as const) {
    await ada.page.getByRole('radio', { name: theme }).click();
    await audit(ada.page, `home (${theme})`);
  }
  await ada.page.getByRole('radio', { name: 'Light theme' }).click();

  await ada.page.getByLabel('Start a new meeting').fill('Audit');
  await ada.page.getByRole('button', { name: 'Create room' }).click();
  await expect(tiles(ada.page)).toHaveCount(1);

  await ben.page.goto(ada.page.url());
  await expect(ben.page.getByRole('button', { name: 'Join now' })).toBeVisible();
  await audit(ben.page, 'lobby');

  for (const theme of ['Light theme', 'Dark theme'] as const) {
    await ada.page.getByRole('radio', { name: theme }).click();
    await audit(ada.page, `call (${theme})`);

    await ada.page.getByRole('button', { name: /^Chat/ }).click();
    await expect(
      ada.page.getByRole('region', { name: 'Chat' }).getByText('End-to-end encrypted.'),
    ).toBeVisible({
      timeout: 30_000,
    });
    await audit(ada.page, `chat (${theme})`);

    await ada.page.getByRole('button', { name: /^Files/ }).click();
    await expect(ada.page.getByRole('region', { name: 'Files' })).toBeVisible();
    await audit(ada.page, `files (${theme})`);
    await ada.page.getByRole('button', { name: 'Close files' }).click();

    await ada.page.getByRole('button', { name: /^Whiteboard/ }).click();
    await expect(ada.page.getByTestId('board-canvas')).toBeVisible();
    await audit(ada.page, `whiteboard (${theme})`);
    await ada.page.getByRole('button', { name: 'Close whiteboard' }).click();

    await ada.page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(ada.page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await audit(ada.page, `shortcuts (${theme})`);
    await ada.page.keyboard.press('Escape');
  }

  for (const p of [ada, ben]) await p.context.close();
});
