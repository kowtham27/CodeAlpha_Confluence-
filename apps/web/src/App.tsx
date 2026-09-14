import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse } from '@confluence/shared';
import { getHealth } from './lib/api';

type Probe =
  | { state: 'loading' }
  | { state: 'loaded'; health: HealthResponse }
  | { state: 'error'; message: string };

const PHASES = [
  { n: 0, name: 'Foundation', done: true },
  { n: 1, name: 'Authentication & authorization', done: false },
  { n: 2, name: 'Rooms & signaling backbone', done: false },
  { n: 3, name: 'Video calling (mesh WebRTC)', done: false },
  { n: 4, name: 'Screen sharing', done: false },
  { n: 5, name: 'File sharing', done: false },
  { n: 6, name: 'Collaborative whiteboard', done: false },
  { n: 7, name: 'E2E encryption & hardening', done: false },
  { n: 8, name: 'Polish', done: false },
];

function Dot({ up }: { up: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2 rounded-full"
      style={{ backgroundColor: up ? 'var(--color-up)' : 'var(--color-down)' }}
    />
  );
}

export default function App() {
  const [probe, setProbe] = useState<Probe>({ state: 'loading' });

  const check = useCallback(async () => {
    setProbe({ state: 'loading' });
    try {
      setProbe({ state: 'loaded', health: await getHealth() });
    } catch (error) {
      setProbe({
        state: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, []);

  useEffect(() => {
    void check();
    const id = setInterval(() => void check(), 10_000);
    return () => clearInterval(id);
  }, [check]);

  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col gap-8 px-4 py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Confluence</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--color-ink-muted)' }}>
          Real-time conferencing and collaboration. Phase 0 — foundation.
        </p>
      </header>

      <section
        className="rounded-xl border p-4"
        style={{ borderColor: 'var(--color-edge)', backgroundColor: 'var(--color-surface-raised)' }}
        aria-live="polite"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">System health</h2>
          <button
            type="button"
            onClick={() => void check()}
            className="rounded-md px-2 py-1 text-xs font-medium text-white"
            style={{ backgroundColor: 'var(--color-accent)' }}
          >
            Re-check
          </button>
        </div>

        {probe.state === 'loading' && (
          <p className="text-sm" style={{ color: 'var(--color-ink-muted)' }}>
            Checking…
          </p>
        )}

        {probe.state === 'error' && (
          <p className="text-sm" style={{ color: 'var(--color-down)' }}>
            API unreachable — {probe.message}
          </p>
        )}

        {probe.state === 'loaded' && (
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            {Object.entries(probe.health.dependencies).map(([name, dep]) => (
              <div key={name} className="contents">
                <dt className="flex items-center gap-2 capitalize">
                  <Dot up={dep.status === 'up'} />
                  {name}
                </dt>
                <dd className="text-right tabular-nums" style={{ color: 'var(--color-ink-muted)' }}>
                  {dep.status === 'up' ? `${dep.latencyMs ?? 0} ms` : (dep.error ?? 'down')}
                </dd>
              </div>
            ))}
            <dt className="pt-2">Uptime</dt>
            <dd
              className="pt-2 text-right tabular-nums"
              style={{ color: 'var(--color-ink-muted)' }}
            >
              {probe.health.uptimeSeconds}s
            </dd>
          </dl>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium">Build progress</h2>
        <ol className="space-y-1 text-sm">
          {PHASES.map((phase) => (
            <li key={phase.n} className="flex items-center gap-2">
              <span
                className="tabular-nums"
                style={{ color: 'var(--color-ink-muted)' }}
              >{`${phase.n}.`}</span>
              <span style={{ color: phase.done ? 'var(--color-ink)' : 'var(--color-ink-muted)' }}>
                {phase.name}
              </span>
              {phase.done && (
                <span className="text-xs" style={{ color: 'var(--color-up)' }}>
                  done
                </span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
