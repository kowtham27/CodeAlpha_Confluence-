import { useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { messageResponseSchema } from '@confluence/shared';
import { Alert, AuthShell, Button, Field } from '../components/ui';
import { request } from '../lib/api';

function emailFromState(state: unknown): string {
  if (state && typeof state === 'object' && 'email' in state && typeof state.email === 'string') {
    return state.email;
  }
  return '';
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState(emailFromState(useLocation().state));
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await request('/auth/password/forgot', {
        method: 'POST',
        body: { email },
        schema: messageResponseSchema,
      });
      // Deliberately the same message whether or not the account exists.
      setSent(res.message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter your email and we'll send you a link to choose a new password."
      footer={
        <Link to="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div className="flex flex-col gap-4">
          <Alert tone="success">{sent}</Alert>
          <p className="text-sm text-ink-muted">
            The link expires in 1 hour. If nothing arrives, check your spam folder or try again.
          </p>
          {import.meta.env.DEV && (
            <Alert tone="info">
              <strong className="text-ink">Development:</strong> emails are caught by Mailpit.{' '}
              <a
                href="http://localhost:8025"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-accent hover:underline"
              >
                Open the inbox
              </a>
            </Alert>
          )}
        </div>
      ) : (
        <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
          {error && <Alert tone="error">{error}</Alert>}
          <Field
            label="Email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" busy={busy} className="mt-2">
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
