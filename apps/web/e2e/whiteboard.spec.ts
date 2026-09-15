import { expect, test, type Page } from '@playwright/test';
import { person } from './media';

/**
 * Spec Phase 6: a shared whiteboard. Checked the way a person would see it:
 * by reading pixels back from the other participants' canvases, and by the
 * board's accessible item count, never by peeking at app state.
 */

const board = (page: Page) => page.getByRole('region', { name: 'Whiteboard' });
const liveCanvas = (page: Page) => board(page).getByTestId('board-canvas');
const items = (page: Page, n: number) =>
  board(page).getByRole('img', { name: `Whiteboard with ${n} ${n === 1 ? 'item' : 'items'}` });

async function openBoard(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Whiteboard/ }).click();
  await expect(liveCanvas(page)).toBeVisible({ timeout: 30_000 });
  await expect(board(page).getByRole('status', { name: 'Loading the whiteboard' })).toHaveCount(0, {
    timeout: 30_000,
  });
}

/** Board point (fractions of the board) to page coordinates. */
async function at(page: Page, fx: number, fy: number): Promise<[number, number]> {
  const box = await liveCanvas(page).boundingBox();
  if (!box) throw new Error('no board');
  return [box.x + box.width * fx, box.y + box.height * fy];
}

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(...(await at(page, ...from)));
  await page.mouse.down();
  await page.mouse.move(...(await at(page, ...to)), { steps: 25 });
  await page.mouse.up();
}

/** RGBA of a pixel on one of the board's canvases, at fractions of its size. */
function pixel(page: Page, which: 'base' | 'live', fx: number, fy: number) {
  return board(page)
    .locator('canvas')
    .nth(which === 'base' ? 0 : 1)
    .evaluate(
      (canvas: HTMLCanvasElement, [x, y]) => {
        const ctx = canvas.getContext('2d');
        const data = ctx?.getImageData(
          Math.floor(canvas.width * x),
          Math.floor(canvas.height * y),
          1,
          1,
        ).data;
        return data ? [...data] : [0, 0, 0, 0];
      },
      [fx, fy] as const,
    );
}

const isRed = ([r = 0, g = 0, b = 0]: number[]) => r > 150 && g < 110 && b < 110;
const isWhite = ([r = 0, g = 0, b = 0]: number[]) => r > 240 && g > 240 && b > 240;

test('whiteboard: live for everyone, kept for latecomers, erase and undo sync, host clears', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const ada = await person(browser, request, 'Ada');
  const ben = await person(browser, request, 'Ben');

  await ada.page.getByLabel('Start a new meeting').fill('Sketching');
  await ada.page.getByRole('button', { name: 'Create room' }).click();
  await expect(ada.page.getByRole('heading', { name: 'Sketching' })).toBeVisible();
  const link = ada.page.url();
  await ben.page.goto(link);
  await openBoard(ada.page);
  await openBoard(ben.page);

  // Ada picks thick red and starts a line across the middle. While her mouse
  // is still down, Ben already sees it being drawn.
  await board(ada.page).getByRole('radio', { name: 'Red' }).click();
  await board(ada.page).getByRole('radio', { name: 'Thick' }).click();
  await ada.page.mouse.move(...(await at(ada.page, 0.2, 0.5)));
  await ada.page.mouse.down();
  await ada.page.mouse.move(...(await at(ada.page, 0.6, 0.5)), { steps: 25 });
  await expect.poll(async () => isRed(await pixel(ben.page, 'live', 0.4, 0.5))).toBe(true);
  await ada.page.mouse.move(...(await at(ada.page, 0.8, 0.5)), { steps: 10 });
  await ada.page.mouse.up();

  // Committed: it is on Ben's board for good.
  await expect(items(ben.page, 1)).toBeVisible();
  await expect.poll(async () => isRed(await pixel(ben.page, 'base', 0.5, 0.5))).toBe(true);

  // Text, typed in place.
  await board(ada.page).getByRole('button', { name: 'Text (T)' }).click();
  await ada.page.mouse.click(...(await at(ada.page, 0.1, 0.15)));
  await ada.page.keyboard.type('Plan for Q3');
  await ada.page.keyboard.press('Enter');
  await expect(items(ben.page, 2)).toBeVisible();

  // Someone who arrives later sees everything drawn before they came.
  const cy = await person(browser, request, 'Cy');
  await cy.page.goto(link);
  await openBoard(cy.page);
  await expect(items(cy.page, 2)).toBeVisible();
  await expect.poll(async () => isRed(await pixel(cy.page, 'base', 0.5, 0.5))).toBe(true);

  // Ben erases the line with a stroke across it; everyone loses it.
  await board(ben.page).getByRole('button', { name: 'Eraser (E)' }).click();
  await drag(ben.page, [0.5, 0.35], [0.5, 0.65]);
  for (const page of [ada.page, ben.page, cy.page]) await expect(items(page, 1)).toBeVisible();
  await expect.poll(async () => isWhite(await pixel(ada.page, 'base', 0.5, 0.5))).toBe(true);

  // Undo is per person: Ben's undo brings back what Ben erased.
  await ben.page.keyboard.press('Control+z');
  for (const page of [ada.page, cy.page]) await expect(items(page, 2)).toBeVisible();

  // Closed boards show that something changed.
  await cy.page.getByRole('button', { name: 'Close whiteboard' }).click();
  await board(ada.page).getByRole('button', { name: 'Pen (P)' }).click();
  await drag(ada.page, [0.3, 0.8], [0.7, 0.9]);
  await expect(items(ada.page, 3)).toBeVisible();
  await expect(items(ben.page, 3)).toBeVisible();
  await expect(cy.page.getByRole('button', { name: 'Whiteboard (new changes)' })).toBeVisible();

  // Export saves a PNG.
  const [png] = await Promise.all([
    ada.page.waitForEvent('download'),
    board(ada.page).getByRole('button', { name: 'Save as image' }).click(),
  ]);
  expect(png.suggestedFilename()).toMatch(/^whiteboard-\d{4}-\d{2}-\d{2}\.png$/);

  // Only the host may wipe the board, and it goes for everyone.
  await expect(board(ben.page).getByRole('button', { name: 'Clear' })).toHaveCount(0);
  await board(ada.page).getByRole('button', { name: 'Clear', exact: true }).click();
  await board(ada.page).getByRole('button', { name: 'Clear for everyone' }).click();
  for (const page of [ada.page, ben.page]) await expect(items(page, 0)).toBeVisible();

  for (const p of [ada, ben, cy]) await p.context.close();
});
