import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { PASSWORD_MIN_LENGTH, resetPasswordResponseSchema } from '@confluence/shared';
import { Alert, AuthShell, Button, Field } from '../components/ui';
import { ApiError, request } from '../lib/api';
import { useAuth } from '../stores/auth';

/** Pure read: StrictMode may call a state initializer twice. */
function readTokenFromUrl(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get('token');
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [token] = useState(readTokenFromUrl);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  // Strip the token from the address bar once read, so it does not sit in
  // history. Idempotent, so StrictMode's double effect is harmless.
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { email } = await request('/auth/password/reset', {
        method: 'POST',
        body: { token, password },
        schema: resetPasswordResponseSchema,
      });
      // Every session was just revoked server-side, this tab's included.
      useAuth.getState().signOut();
      void navigate('/login', { replace: true, state: { email, passwordReset: true } });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught : new ApiError(0, 'INTERNAL', 'Something went wrong.'),
      );
    } finally {
      setBusy(false);
    }
  }

  const linkDead = !token || error?.code === 'INVALID_TOKEN';

  if (linkDead) {
    return (
      <AuthShell
        title="Link not valid"
        footer={
          <Link to="/login" className="font-medium text-accent hover:underline">
            Back to sign in
          </Link>
        }
      >
        <div className="flex flex-col gap-4">
          <Alert tone="error">
            {error?.message ?? 'This link is incomplete. Open it from your email again.'}
          </Alert>
          <Link
            to="/forgot-password"
            className="inline-flex items-center justify-center rounded-lg border border-edge-strong bg-surface-raised px-4 py-2.5 text-sm font-medium hover:bg-surface-sunken"
          >
            Send a new reset link
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="You'll be signed out on every device, then you can sign in with the new one."
    >
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
        {/* Field-level problems are shown on the field; a banner would repeat them vaguely. */}
        {error && !error.details && <Alert tone="error">{error.message}</Alert>}
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          autoFocus
          minLength={PASSWORD_MIN_LENGTH}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase works well.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          errors={error?.details?.['password']}
        />
        <Button type="submit" busy={busy} className="mt-2">
          Update password
        </Button>
      </form>
    </AuthShell>
  );
}
