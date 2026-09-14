import { useEffect, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { FullPageSpinner } from './components/ui';
import { RealtimeProvider } from './lib/realtime-context';
import { bootstrapSession } from './lib/session';
import { CheckEmailPage } from './pages/CheckEmailPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { RoomPage } from './pages/RoomPage';
import { VerifyEmailPage } from './pages/VerifyEmailPage';
import { useAuth } from './stores/auth';

/**
 * Layout route for the whole signed-in area. Because it is a layout, it stays
 * mounted while the user moves between pages inside it, and so does the one
 * realtime socket it provides: going from home into a room must not drop and
 * reopen the connection (the room would see you leave and rejoin).
 */
function SignedInArea() {
  const status = useAuth((s) => s.status);
  const location = useLocation();

  if (status === 'booting') return <FullPageSpinner label="Restoring your session" />;
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return (
    <RealtimeProvider>
      <Outlet />
    </RealtimeProvider>
  );
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
      <Route element={<SignedInArea />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/r/:slug" element={<RoomPage />} />
      </Route>
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
