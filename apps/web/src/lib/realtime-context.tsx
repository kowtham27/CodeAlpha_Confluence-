import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '../stores/auth';
import { connectRealtime, type AppSocket } from './realtime';

const RealtimeContext = createContext<AppSocket | null>(null);

/**
 * Owns the one authenticated socket for the signed-in area. Pages read it
 * with useSocket(); it is null until the connection is created.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status);
  const [socket, setSocket] = useState<AppSocket | null>(null);

  useEffect(() => {
    if (status !== 'authenticated') return;
    const created = connectRealtime();
    setSocket(created);
    return () => {
      created.disconnect();
      setSocket(null);
    };
  }, [status]);

  return <RealtimeContext.Provider value={socket}>{children}</RealtimeContext.Provider>;
}

export function useSocket(): AppSocket | null {
  return useContext(RealtimeContext);
}
