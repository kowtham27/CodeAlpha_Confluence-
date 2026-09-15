import { expect, test, type Page } from '@playwright/test';
import {
  AUTH,
  createVerifiedAccount,
  enterRoom,
  joinFromLobby,
  signIn,
  uniqueEmail,
} from './support';

function participants(page: Page) {
  return page.getByRole('list', { name: 'Participants' }).getByRole('listitem');
}

test('spec deliverable: two people join one room and see each other, live', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();

  const hostEmail = uniqueEmail('host');
  const guestEmail = uniqueEmail('guest');
  await createVerifiedAccount(host, request, 'Kowtham', hostEmail);
  await createVerifiedAccount(guest, request, 'Priya', guestEmail);
  await signIn(host, hostEmail);
  await signIn(guest, guestEmail);
  await expect(host.getByRole('heading', { name: 'Hi, Kowtham' })).toBeVisible(AUTH);
  await expect(guest.getByRole('heading', { name: 'Hi, Priya' })).toBeVisible(AUTH);

  // Host creates a room and lands in it alone.
  await host.getByLabel('Start a new meeting').fill('Team sync');
  await host.getByRole('button', { name: 'Create room' }).click();
  await expect(host.getByRole('heading', { name: 'Team sync' })).toBeVisible();
  await expect(participants(host)).toHaveCount(1);
  await expect(host.getByText('You are the only one here.')).toBeVisible();
  const inviteUrl = host.url();
  expect(inviteUrl).toMatch(/\/r\/[A-Za-z0-9_-]{12}$/);

  // Guest pastes the invite link on their home page.
  await guest.getByLabel('Join with a link or code').fill(inviteUrl);
  await guest.getByRole('button', { name: 'Join', exact: true }).click();
  // The lobby first: nothing is shared until they choose to join.
  await expect(guest.getByRole('heading', { name: 'Team sync' })).toBeVisible();
  await expect(guest.getByText('Hosted by Kowtham · 1 person is here')).toBeVisible();
  await expect(participants(guest)).toHaveCount(0);
  await joinFromLobby(guest);

  // Both see both, without reloading.
  for (const page of [host, guest]) {
    await expect(participants(page)).toHaveCount(2);
    await expect(participants(page).filter({ hasText: 'Kowtham' })).toContainText('Host');
    await expect(participants(page).filter({ hasText: 'Priya' })).toBeVisible();
    await expect(page.getByText('2 of 6 people')).toBeVisible();
  }
  await expect(host.getByText('Priya joined')).toBeVisible();
  await expect(guest.getByText('Host controls')).toHaveCount(0);

  // Host locks the meeting; the guest is told immediately.
  await host.getByRole('button', { name: 'Lock meeting' }).click();
  await expect(host.getByRole('button', { name: 'Unlock meeting' })).toBeVisible();
  await expect(guest.getByText('The host has locked this meeting.')).toBeVisible();

  // Guest leaves; the host sees them go.
  await guest.getByRole('button', { name: 'Leave' }).click();
  await expect(guest.getByRole('heading', { name: 'Hi, Priya' })).toBeVisible();
  await expect(participants(host)).toHaveCount(1);
  await expect(host.getByText('Priya left')).toBeVisible();

  // The guest already belongs to the meeting, so the lock does not keep them out.
  await enterRoom(guest, inviteUrl);
  await expect(participants(guest)).toHaveCount(2);

  // Host ends the meeting for everyone.
  await host.getByRole('button', { name: 'End meeting' }).click();
  await host.getByRole('button', { name: 'End for everyone' }).click();
  await expect(host.getByRole('heading', { name: 'Hi, Kowtham' })).toBeVisible();
  await expect(guest.getByRole('heading', { name: 'This meeting has ended' })).toBeVisible();

  // The ended room is listed as ended, and its link no longer works.
  await expect(host.getByRole('list', { name: 'Your rooms' })).toContainText('Ended');
  await guest.goto(inviteUrl);
  await expect(guest.getByRole('heading', { name: 'This meeting has ended' })).toBeVisible();

  await hostCtx.close();
  await guestCtx.close();
});

test('one seat per person: a second tab takes over, and can be taken back', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000);
  const email = uniqueEmail('tabs');
  await createVerifiedAccount(page, request, 'Kowtham', email);
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Hi, Kowtham' })).toBeVisible(AUTH);

  await page.getByLabel('Start a new meeting').fill('Two tabs');
  await page.getByRole('button', { name: 'Create room' }).click();
  await expect(participants(page)).toHaveCount(1);

  // Same browser, same account, second tab.
  const tab2 = await context.newPage();
  await enterRoom(tab2, page.url());
  await expect(participants(tab2)).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'You joined from somewhere else' })).toBeVisible();

  await page.getByRole('button', { name: 'Use this tab instead' }).click();
  await expect(participants(page)).toHaveCount(1);
  await expect(tab2.getByRole('heading', { name: 'You joined from somewhere else' })).toBeVisible();
});

test('a bad or unknown room link explains itself', async ({ page, request }) => {
  const email = uniqueEmail('badlink');
  await createVerifiedAccount(page, request, 'Kowtham', email);
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: 'Hi, Kowtham' })).toBeVisible(AUTH);

  await page.goto('/r/AAAAAAAAAAAA');
  await expect(page.getByRole('heading', { name: 'Room not found' })).toBeVisible();
  await page.goto('/r/!!');
  await expect(page.getByRole('heading', { name: 'Room not found' })).toBeVisible();
});
