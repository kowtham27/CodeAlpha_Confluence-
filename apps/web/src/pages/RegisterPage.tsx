import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { messageResponseSchema, PASSWORD_MIN_LENGTH } from '@confluence/shared';
import { Alert, AuthShell, Button, Field } from '../components/ui';
import { ApiError, request } from '../lib/api';

export function RegisterPage() {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await request('/auth/register', {
        method: 'POST',
        body: { displayName, email, password },
        schema: messageResponseSchema,
      });
      // The response is the same whether or not the email was new, by design.
      void navigate('/check-email', { state: { email } });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'VALIDATION_FAILED' && caught.details) {
        setFieldErrors(caught.details);
      } else {
        setError(caught instanceof Error ? caught.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Video calls, screen sharing, files and a shared whiteboard."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4" noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        <Field
          label="Name"
          autoComplete="name"
          required
          maxLength={64}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          errors={fieldErrors['displayName']}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          errors={fieldErrors['email']}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short phrase works well.`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          errors={fieldErrors['password']}
        />
        <Button type="submit" busy={busy} className="mt-2">
          Create account
        </Button>
      </form>
    </AuthShell>
  );
}
