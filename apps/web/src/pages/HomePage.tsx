import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { HealthResponse } from '@confluence/shared';
import { RoomsPanel } from '../components/RoomsPanel';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { Button, Logo } from '../components/ui';
import { getHealth } from '../lib/api';
import { logout, logoutEverywhere } from '../lib/session';
import { useAuth, type RealtimeStatus } from '../stores/auth';

const PHASES = [
  'Foundation',
  'Authentication & email verification',
  'Rooms & signaling backbone',
  'Video calling (mesh WebRTC)',
  'Screen sharing',
  'File sharing',
  'Collaborative whiteboard',
  'E2E encryption & hardening',
  'Polish',
];
// Every phase is built; keep this in step with the README's phase plan.
const COMPLETED_PHASES = PHASES.length;

function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-edge bg-surface-raised p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatusDot({ tone }: { tone: 'up' | 'down' | 'pending' }) {
  const color = tone === 'up' ? 'bg-up' : tone === 'down' ? 'bg-down' : 'bg-warn';
  return (
    <span aria-hidden="true" className={`inline-block size-2 shrink-0 rounded-full ${color}`} />
  );
}

const REALTIME_LABEL: Record<RealtimeStatus, { text: string; tone: 'up' | 'down' | 'pending' }> = {
  online: { text: 'Connected', tone: 'up' },
  connecting: { text: 'Connecting…', tone: 'pending' },
  offline: { text: 'Offline', tone: 'down' },
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export function HomePage() {
  const user = useAuth((s) => s.user);
  const realtime = useAuth((s) => s.realtime);
  const [busy, setBusy] = useState<'one' | 'all' | null>(null);

  if (!user) return null;
  const live = REALTIME_LABEL[realtime];

  async function signOut(scope: 'one' | 'all') {
    setBusy(scope);
    try {
      await (scope === 'one' ? logout() : logoutEverywhere());
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-edge bg-surface-raised">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <Logo />
          <div className="flex items-center gap-3">
            <ThemeSwitcher />
            <span
              aria-hidden="true"
              className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent"
            >
              {initials(user.displayName)}
            </span>
            <Button variant="ghost" busy={busy === 'one'} onClick={() => void signOut('one')}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hi, {user.displayName}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Start a meeting or join one with a link. Video arrives in the next phase.
          </p>
        </div>

        <RoomsPanel />

        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Account">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
              <dt className="text-ink-muted">Email</dt>
              <dd className="truncate" title={user.email}>
                {user.email}
              </dd>
              <dt className="text-ink-muted">Status</dt>
              <dd className="flex items-center gap-2">
                <StatusDot tone={user.emailVerified ? 'up' : 'pending'} />
                {user.emailVerified ? 'Verified' : 'Unverified'}
              </dd>
              <dt className="text-ink-muted">Member since</dt>
              <dd>
                {new Date(user.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
              </dd>
            </dl>
          </Card>

          <Card title="This session">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
              <dt className="text-ink-muted">Realtime</dt>
              <dd className="flex items-center gap-2" aria-live="polite">
                <StatusDot tone={live.tone} />
                {live.text}
              </dd>
              <dt className="text-ink-muted">Access token</dt>
              <dd>In memory only, renews automatically</dd>
            </dl>
            <div className="mt-5 border-t border-edge pt-4">
              <p className="mb-3 text-xs text-ink-muted">
                Ends every session on every device, including open tabs, immediately.
              </p>
              <Button variant="danger" busy={busy === 'all'} onClick={() => void signOut('all')}>
                Sign out everywhere
              </Button>
            </div>
          </Card>

          <HealthCard />

          <Card title="Build progress">
            <ol className="flex flex-col gap-1.5 text-sm">
              {PHASES.map((name, index) => {
                const done = index < COMPLETED_PHASES;
                return (
                  <li key={name} className="flex items-center gap-2.5">
                    <span className="w-4 text-right tabular-nums text-ink-muted">{index}</span>
                    <span className={done ? 'text-ink' : 'text-ink-muted'}>{name}</span>
                    {done && <span className="text-xs font-medium text-up">done</span>}
                  </li>
                );
              })}
            </ol>
          </Card>
        </div>
      </main>
    </div>
  );
}

function HealthCard() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const check = useCallback(async () => {
    try {
      setHealth(await getHealth());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void check();
    const id = setInterval(() => void check(), 15_000);
    return () => clearInterval(id);
  }, [check]);

  return (
    <Card
      title="System health"
      action={
        <button
          type="button"
          onClick={() => void check()}
          className="rounded-md px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink"
        >
          Re-check
        </button>
      }
    >
      {failed && <p className="text-sm text-down">API unreachable.</p>}
      {!failed && !health && <p className="text-sm text-ink-muted">Checking…</p>}
      {health && !failed && (
        <dl className="grid grid-cols-[1fr_auto] gap-y-2.5 text-sm">
          {Object.entries(health.dependencies).map(([name, dep]) => (
            <div key={name} className="contents">
              <dt className="flex items-center gap-2 capitalize">
                <StatusDot tone={dep.status === 'up' ? 'up' : 'down'} />
                {name}
              </dt>
              <dd className="text-right tabular-nums text-ink-muted">
                {dep.status === 'up' ? `${dep.latencyMs ?? 0} ms` : 'down'}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}
