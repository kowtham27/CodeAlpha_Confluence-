import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { FullPageSpinner } from './components/ui';
import { connectRealtime } from './lib/realtime';
import { bootstrapSession } from './lib/session';
import { CheckEmailPage } from './pages/CheckEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { useAuth } from './stores/auth';

/** Signed-in area. Also owns the realtime socket for as long as it is mounted. */
function RequireAuth({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const location = useLocation();

  useEffect(() => {
    if (status !== 'authenticated') return;
    const socket = connectRealtime();
    return () => {
      socket.disconnect();
    };
  }, [status]);

  if (status === 'booting') return <FullPageSpinner label="Restoring your session" />;
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return children;
}

/** Signed-out pages bounce an authenticated user to the app. */
function GuestOnly({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  if (status === 'booting') return <FullPageSpinner />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  useEffect(() => {
    void bootstrapSession();
  }, []);

  return (
    <Routes>
      <Route
        path="/"
        element={
          <RequireAuth>
            <HomePage />
          </RequireAuth>
        }
      />
      <Route
        path="/login"
        element={
          <GuestOnly>
            <LoginPage />
          </GuestOnly>
        }
      />
      <Route
        path="/register"
        element={
          <GuestOnly>
            <RegisterPage />
          </GuestOnly>
        }
      />
      <Route
        path="/check-email"
        element={
          <GuestOnly>
            <CheckEmailPage />
          </GuestOnly>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <GuestOnly>
            <ForgotPasswordPage />
          </GuestOnly>
        }
      />
      {/* Not guest-only: emailed links must work whether or not this browser
          happens to be signed in. */}
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
