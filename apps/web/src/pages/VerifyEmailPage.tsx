import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { messageResponseSchema, verifyEmailResponseSchema } from '@confluence/shared';
import { Alert, AuthShell, Button, Field, Spinner } from '../components/ui';
import { request } from '../lib/api';

type State =
  { kind: 'verifying' } | { kind: 'verified'; email: string } | { kind: 'failed'; message: string };

/**
 * Reads the token from the URL fragment (#token=...), then immediately strips
 * it from the address bar so it does not linger in history or get copied
 * along with the URL.
 */
function takeTokenFromUrl(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  if (token) window.history.replaceState(null, '', window.location.pathname);
  return token;
}

export function VerifyEmailPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: 'verifying' });
  // StrictMode runs effects twice in development; a verification token is
  // single-use, so the second run must not submit it again.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const token = takeTokenFromUrl();
    if (!token) {
      setState({
        kind: 'failed',
        message: 'This link is incomplete. Open it from your email again.',
      });
      return;
    }
    request('/auth/verify-email', {
      method: 'POST',
      body: { token },
      schema: verifyEmailResponseSchema,
    })
      .then(({ email }) => setState({ kind: 'verified', email }))
      .catch((caught: unknown) =>
        setState({
          kind: 'failed',
          message: caught instanceof Error ? caught.message : 'Verification failed.',
        }),
      );
  }, []);

  if (state.kind === 'verifying') {
    return (
      <AuthShell title="Verifying your email">
        <div className="flex items-center gap-3 text-sm text-ink-muted">
          <Spinner label="Verifying" /> One moment…
        </div>
      </AuthShell>
    );
  }

  if (state.kind === 'verified') {
    return (
      <AuthShell title="Email verified" subtitle="Your account is ready.">
        <Button
          className="w-full"
          onClick={() => void navigate('/login', { state: { email: state.email, verified: true } })}
        >
          Continue to sign in
        </Button>
      </AuthShell>
    );
  }

  return <VerificationFailed message={state.message} />;
}

function VerificationFailed({ message }: { message: string }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await request('/auth/verify-email/resend', {
        method: 'POST',
        body: { email },
        schema: messageResponseSchema,
      });
      setSent(res.message);
    } catch (caught) {
      setSent(caught instanceof Error ? caught.message : 'Could not send a new link.');
    } finally {
      setBusy(false);
    }
  }

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
        <Alert tone="error">{message}</Alert>
        {sent ? (
          <Alert tone="success">{sent}</Alert>
        ) : (
          <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
            <Field
              label="Send a new link to"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Button type="submit" variant="secondary" busy={busy}>
              Send new link
            </Button>
          </form>
        )}
      </div>
    </AuthShell>
  );
}
