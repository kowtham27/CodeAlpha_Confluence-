import { create } from 'zustand';
import type { AuthResponse, PublicUser } from '@confluence/shared';

export type AuthStatus = 'booting' | 'authenticated' | 'anonymous';
export type RealtimeStatus = 'offline' | 'connecting' | 'online';

interface AuthState {
  status: AuthStatus;
  user: PublicUser | null;
  /**
   * Spec: the access token lives in memory only, never localStorage, where
   * any injected script could read it. A reload loses it; the httpOnly
   * refresh cookie restores it.
   */
  accessToken: string | null;
  /** Shown on the sign-in page after an involuntary sign-out. */
  notice: string | null;
  realtime: RealtimeStatus;
  /** True while this tab is signing itself out, so its own socket closing is not news. */
  signingOut: boolean;

  setSession: (session: AuthResponse) => void;
  signOut: (notice?: string) => void;
  setRealtime: (status: RealtimeStatus) => void;
  beginSignOut: () => void;
  clearNotice: () => void;
}

export const useAuth = create<AuthState>()((set) => ({
  status: 'booting',
  user: null,
  accessToken: null,
  notice: null,
  realtime: 'offline',
  signingOut: false,

  setSession: (session) =>
    set({
      status: 'authenticated',
      user: session.user,
      accessToken: session.accessToken,
      notice: null,
    }),
  signOut: (notice) =>
    set({
      status: 'anonymous',
      user: null,
      accessToken: null,
      realtime: 'offline',
      signingOut: false,
      notice: notice ?? null,
    }),
  setRealtime: (realtime) => set({ realtime }),
  beginSignOut: () => set({ signingOut: true }),
  clearNotice: () => set({ notice: null }),
}));
