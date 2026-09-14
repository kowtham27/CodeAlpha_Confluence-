import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { messageResponseSchema } from '@confluence/shared';
import { Alert, AuthShell, Button } from '../components/ui';
import { request } from '../lib/api';

const RESEND_COOLDOWN_SECONDS = 30;

function emailFromState(state: unknown): string | null {
  if (state && typeof state === 'object' && 'email' in state && typeof state.email === 'string') {
    return state.email;
  }
  return null;
}

export function CheckEmailPage() {
  const email = emailFromState(useLocation().state);
  const [cooldown, setCooldown] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function resend() {
    if (!email) return;
    setCooldown(RESEND_COOLDOWN_SECONDS);
    try {
      const { message } = await request('/auth/verify-email/resend', {
        method: 'POST',
        body: { email },
        schema: messageResponseSchema,
      });
      setStatus(message);
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : 'Could not resend right now.');
    }
  }

  return (
    <AuthShell
      title="Check your email"
      subtitle={
        email ? (
          <>
            We sent a verification link to <strong className="text-ink">{email}</strong>.
          </>
        ) : (
          'We sent you a verification link.'
        )
      }
      footer={
        <Link to="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      }
    >
      <div className="flex flex-col gap-4 text-sm text-ink-muted">
        <p>Open the link to activate your account. It expires in 24 hours.</p>
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
        {status && <Alert tone="success">{status}</Alert>}
        {email && (
          <Button variant="secondary" onClick={() => void resend()} disabled={cooldown > 0}>
            {cooldown > 0 ? `Resend available in ${cooldown}s` : 'Resend the link'}
          </Button>
        )}
      </div>
    </AuthShell>
  );
}
