import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { messageResponseSchema } from '@confluence/shared';
import { Alert, AuthShell, Button, Field } from '../components/ui';
import { ApiError, request } from '../lib/api';
import { login } from '../lib/session';
import { useAuth } from '../stores/auth';

interface LoginState {
  email?: string;
  verified?: boolean;
  from?: string;
}

/** Router state is untyped and survives reloads via history, so validate it. */
function readState(state: unknown): LoginState {
  if (!state || typeof state !== 'object') return {};
  const read = (key: string): unknown => (state as Record<string, unknown>)[key];
  const email = read('email');
  const from = read('from');
  return {
    ...(typeof email === 'string' ? { email } : {}),
    ...(typeof from === 'string' ? { from } : {}),
    verified: read('verified') === true,
  };
}

export function LoginPage() {
  const navigate = useNavigate();
  const incoming = readState(useLocation().state);
  const notice = useAuth((s) => s.notice);
  const clearNotice = useAuth((s) => s.clearNotice);

  const [email, setEmail] = useState(incoming.email ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [resent, setResent] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setResent(null);
    clearNotice();
    try {
      await login({ email, password });
      // Only same-app paths. "//evil.com" also starts with "/" but is a
      // protocol-relative URL to another site, hence the second check.
      const from = incoming.from;
      const target = from?.startsWith('/') && !from.startsWith('//') ? from : '/';
      void navigate(target, { replace: true });
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught : new ApiError(0, 'INTERNAL', 'Something went wrong.'),
      );
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  async function resendVerification() {
    const res = await request('/auth/verify-email/resend', {
      method: 'POST',
      body: { email },
      schema: messageResponseSchema,
    });
    setResent(res.message);
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Welcome back to Confluence."
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="font-medium text-accent hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
        {incoming.verified && !error && (
          <Alert tone="success">Email verified. Sign in to get started.</Alert>
        )}
        {notice && !error && <Alert tone="warning">{notice}</Alert>}

        {error?.code === 'EMAIL_NOT_VERIFIED' ? (
          <Alert tone="warning">
            <p>{error.message}</p>
            {resent ? (
              <p className="mt-2 font-medium">{resent}</p>
            ) : (
              <button
                type="button"
                onClick={() => void resendVerification()}
                className="mt-2 font-medium text-accent hover:underline"
              >
                Resend verification email
              </button>
            )}
          </Alert>
        ) : (
          error && <Alert tone="error">{error.message}</Alert>
        )}

        <Field
          label="Email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          autoFocus={!incoming.email}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus={Boolean(incoming.email)}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Button type="submit" busy={busy} className="mt-2">
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
