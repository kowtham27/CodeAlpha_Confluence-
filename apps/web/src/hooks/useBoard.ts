import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Participant } from '@confluence/shared';
import { BoardSession } from '../lib/board/session';
import { useSocket } from '../lib/realtime-context';

/**
 * The room's whiteboard session: exists once the room key is ready, and is
 * rebuilt on every rejoin (a new peer id), so the snapshot is always taken
 * after we are back in the room's broadcast channel and nothing is missed.
 */
export function useBoardSession(
  slug: string,
  roomKey: Uint8Array | null,
  self: Participant,
  participants: Participant[],
): BoardSession | null {
  const socket = useSocket();
  const [session, setSession] = useState<BoardSession | null>(null);
  const people = useRef(participants);
  people.current = participants;

  useEffect(() => {
    if (!socket || !roomKey) return;
    const created = new BoardSession(
      socket,
      slug,
      roomKey,
      self.userId,
      (peerId) => people.current.find((p) => p.peerId === peerId)?.userId,
    );
    setSession(created);
    return () => {
      created.close();
      setSession(null);
    };
  }, [socket, slug, roomKey, self.userId, self.peerId]);

  // Forget the drafts and cursors of people who left or went quiet.
  useEffect(() => {
    if (!session) return;
    const timer = setInterval(
      () => session.pruneLive(new Set(people.current.map((p) => p.peerId))),
      2_000,
    );
    return () => clearInterval(timer);
  }, [session]);

  return session;
}

const noSubscribe = () => () => undefined;
const zero = () => 0;

/** Re-renders on committed board changes (not on drafts or cursors). */
export function useBoardVersion(session: BoardSession | null): number {
  return useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.getVersion ?? zero);
}
