import { useState } from 'react';
import { memberKeysResponseSchema } from '@confluence/shared';
import { ApiError, request } from '../../lib/api';
import { loadE2E } from '../../lib/e2e';
import { Spinner } from '../ui';

interface Code {
  userId: string;
  displayName: string;
  code: string | null;
}

/**
 * Safety codes: a fingerprint of each member's public key. Encryption keys
 * are handed out by the server, so a malicious server could in principle
 * hand out its own. Two people who read each other's code aloud (or compare
 * over another channel) and see a match know that cannot have happened.
 */
export function SafetyCodes({ slug, selfUserId }: { slug: string; selfUserId: string }) {
  const [codes, setCodes] = useState<Code[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [{ members }, e2e] = await Promise.all([
        request(`/rooms/${slug}/members/keys`, { schema: memberKeysResponseSchema, auth: true }),
        loadE2E(),
      ]);
      const computed = await Promise.all(
        members.map(async (m) => ({
          userId: m.userId,
          displayName: m.displayName,
          code: m.publicKey ? await e2e.safetyCode(await e2e.fromBase64Url(m.publicKey)) : null,
        })),
      );
      // Yours first: it is the one you read out.
      setCodes(
        computed.sort((a, b) => Number(b.userId === selfUserId) - Number(a.userId === selfUserId)),
      );
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load safety codes.');
    }
  }

  return (
    <details
      className="group rounded-xl bg-surface-sunken text-sm"
      onToggle={(e) => {
        if (e.currentTarget.open && !codes) void load();
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl px-4 py-2.5 font-medium select-none hover:bg-ink/5 [&::-webkit-details-marker]:hidden">
        <span className="flex-1">Compare safety codes</span>
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="text-ink-muted transition-transform group-open:rotate-180"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="flex flex-col gap-3 px-4 pt-1 pb-4">
        <p className="text-xs leading-[18px] text-ink-muted">
          Read your code to the others, and check theirs. If every code matches what the person
          reads out, no one, not even the server, can be listening in.
        </p>
        {error && <p className="text-xs text-down">{error}</p>}
        {!codes && !error && <Spinner label="Loading safety codes" />}
        {codes && (
          <ul aria-label="Safety codes" className="flex flex-col gap-2.5">
            {codes.map((c) => (
              <li key={c.userId}>
                <span className="block text-xs font-medium">
                  {c.userId === selfUserId ? 'Your code' : c.displayName}
                </span>
                <span className="block font-mono text-[13px] tracking-wide text-ink-muted tabular-nums">
                  {c.code ?? 'No keys yet'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
