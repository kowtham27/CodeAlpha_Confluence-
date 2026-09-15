import { useEffect, useState } from 'react';
import type { PublicUser } from '@confluence/shared';
import { Popover } from '../components/Popover';
import { RoomsList, StartOrJoin } from '../components/RoomsPanel';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { Avatar, Button, Logo } from '../components/ui';
import { logout, logoutEverywhere } from '../lib/session';
import { useAuth } from '../stores/auth';

/** "10:42 · Tue, Sep 16", like the corner of a meeting app. Minute precision. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <span className="hidden text-[15px] text-ink-muted tabular-nums md:inline">
      {time} · {date}
    </span>
  );
}

function AccountMenu({ user }: { user: PublicUser }) {
  const [busy, setBusy] = useState<'one' | 'all' | null>(null);

  async function signOut(scope: 'one' | 'all') {
    setBusy(scope);
    try {
      await (scope === 'one' ? logout() : logoutEverywhere());
    } finally {
      setBusy(null);
    }
  }

  return (
    <Popover
      label="Account menu"
      button={<Avatar name={user.displayName} seed={user.id} className="size-9 text-sm" />}
      buttonClassName="rounded-full p-0.5 ring-offset-2 ring-offset-surface transition-shadow hover:ring-4 hover:ring-ink/8"
      panelClassName="w-80 p-2"
    >
      {() => (
        <>
          <div className="flex flex-col items-center gap-2 px-4 pt-5 pb-4 text-center">
            <Avatar name={user.displayName} seed={user.id} className="size-16 text-2xl" />
            <p className="mt-1 text-lg">Hi, {user.displayName.split(' ')[0]}!</p>
            <p className="max-w-full truncate text-[13px] text-ink-muted" title={user.email}>
              {user.email}
            </p>
            <p className="text-xs text-ink-muted">
              {user.emailVerified ? 'Email verified' : 'Email not verified'} · member since{' '}
              {new Date(user.createdAt).toLocaleDateString(undefined, {
                month: 'short',
                year: 'numeric',
              })}
            </p>
          </div>
          <div className="flex flex-col gap-1 border-t border-edge p-2">
            <Button
              variant="ghost"
              busy={busy === 'one'}
              onClick={() => void signOut('one')}
              className="w-full justify-start"
            >
              Sign out
            </Button>
            <Button
              variant="ghost"
              busy={busy === 'all'}
              onClick={() => void signOut('all')}
              className="w-full justify-start text-down hover:text-down"
            >
              Sign out everywhere
            </Button>
            <p className="px-6 pb-1 text-xs text-ink-muted">
              Ends every session on every device, including open tabs, at once.
            </p>
          </div>
        </>
      )}
    </Popover>
  );
}

/**
 * The hero: a small, still picture of the product itself (a meeting in
 * progress) rather than stock art. Decorative; the words beside it carry
 * the message.
 */
function MeetingIllustration() {
  // Hand-picked, not hashed: an illustration should look balanced.
  const people = [
    { name: 'Maya Chen', color: '#1f5fbf' },
    { name: 'Tom Okafor', color: '#006a73' },
    { name: 'Lena Ruiz', color: '#7438c0' },
    { name: 'Sam Patel', color: '#1b6e3c' },
  ];
  return (
    <div aria-hidden="true" className="relative mx-auto w-full max-w-[520px]">
      <div className="rounded-[28px] bg-stage p-3 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.45)]">
        <div className="grid grid-cols-2 gap-2">
          {people.map(({ name, color }, i) => (
            <div
              key={name}
              className={`relative flex aspect-[4/3] items-center justify-center rounded-2xl bg-stage-raised ${
                i === 1 ? 'ring-[3px] ring-stage-accent' : ''
              }`}
            >
              <span
                className="flex size-14 items-center justify-center rounded-full text-xl font-medium text-white"
                style={{ backgroundColor: color }}
              >
                {name
                  .split(' ')
                  .map((p) => p[0])
                  .join('')}
              </span>
              <span className="absolute bottom-2 left-3 text-xs font-medium text-stage-ink">
                {name.split(' ')[0]}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-center gap-2 pb-1">
          {['', '', '', ''].map((_, i) => (
            <span key={i} className="size-8 rounded-full bg-stage-raised" />
          ))}
          <span className="h-8 w-12 rounded-full bg-stage-danger" />
        </div>
      </div>
      <div className="absolute -bottom-5 -left-4 flex items-center gap-2 rounded-full bg-surface-raised px-4 py-2.5 text-[13px] font-medium shadow-[0_8px_24px_rgba(15,23,42,0.18)] sm:-left-8">
        <svg
          viewBox="0 0 24 24"
          className="size-4 text-up"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </svg>
        End-to-end encrypted
      </div>
    </div>
  );
}

export function HomePage() {
  const user = useAuth((s) => s.user);
  const realtime = useAuth((s) => s.realtime);
  if (!user) return null;

  return (
    // data-realtime: no longer shown, but tests wait on the live connection.
    <div data-realtime={realtime} className="flex min-h-screen flex-col bg-surface">
      <header className="flex items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <Logo />
        <div className="flex items-center gap-4">
          <Clock />
          <ThemeSwitcher />
          <AccountMenu user={user} />
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-6xl flex-1 items-center gap-14 px-5 py-10 sm:px-8 lg:grid-cols-[1fr_1fr] lg:gap-20 lg:py-16">
        <div className="flex max-w-xl flex-col gap-8">
          <div>
            <h1 className="text-[40px] leading-[48px] font-normal tracking-[-0.02em] sm:text-[44px] sm:leading-[52px]">
              Hi, {user.displayName}
            </h1>
            <p className="mt-4 text-lg leading-7 text-ink-muted">
              Meet face to face, present, and work together. Chat, files and the whiteboard are
              encrypted in your browser, so only the people in the meeting can read them.
            </p>
          </div>
          <StartOrJoin />
          <div className="border-t border-edge pt-6">
            <RoomsList />
          </div>
        </div>

        <div className="hidden flex-col items-center gap-10 lg:flex">
          <MeetingIllustration />
          <div className="max-w-sm text-center">
            <p className="text-xl font-normal">Your meeting, your keys</p>
            <p className="mt-2 text-sm text-ink-muted">
              Invite anyone with a link. Video goes straight between browsers, and the room key
              never reaches our servers.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
