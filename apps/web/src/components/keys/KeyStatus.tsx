import { useState, type FormEvent } from 'react';
import type { RoomKeyState } from '../../hooks/useRoomKey';
import { unlockWithPassword, useKeys } from '../../lib/keys/keystore';
import { LockIcon } from '../call/icons';
import { Alert, Button, Field, Spinner } from '../ui';

/**
 * Where a room's end-to-end encryption stands, for any feature that needs
 * the room key (files, whiteboard): ready, setting up, waiting for a member
 * to share the key, or asking for the password on a browser without keys.
 */
export function KeyStatus({
  state,
  userId,
  readyText,
  waitingText,
}: {
  state: RoomKeyState;
  userId: string;
  readyText: string;
  waitingText: string;
}) {
  if (state.status === 'ready') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-up">
        <LockIcon /> {readyText}
      </p>
    );
  }
  if (state.status === 'locked') return <UnlockKeys userId={userId} />;
  if (state.status === 'waiting') {
    return <Alert tone="info">{waitingText}</Alert>;
  }
  if (state.status === 'error') return <Alert tone="error">{state.message}</Alert>;
  return (
    <p className="flex items-center gap-2 text-xs text-ink-muted">
      <Spinner /> Setting up encryption…
    </p>
  );
}

/** Shown when this browser has no copy of the private key (see keystore.ts). */
function UnlockKeys({ userId }: { userId: string }) {
  const [password, setPassword] = useState('');
  const busy = useKeys((s) => s.status === 'working');
  const error = useKeys((s) => s.error);

  function submit(e: FormEvent) {
    e.preventDefault();
    void unlockWithPassword(userId, password).then(() => setPassword(''));
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border border-edge p-3">
      <p className="text-sm">
        Enter your password to unlock encrypted files and the whiteboard on this device. It never
        leaves your browser.
      </p>
      <Field
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        errors={error ? [error] : undefined}
        required
      />
      <Button type="submit" busy={busy}>
        Unlock
      </Button>
    </form>
  );
}
