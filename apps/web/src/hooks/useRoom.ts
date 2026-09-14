import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ackSchema,
  roomJoinResultSchema,
  type AppError,
  type IceServer,
  type MediaState,
  type Participant,
  type PeerLeftReason,
  type RoomSummary,
} from '@confluence/shared';
import { useSocket } from '../lib/realtime-context';

export type RoomState =
  | { status: 'connecting' }
  | { status: 'joining' }
  | { status: 'joined'; room: RoomSummary; self: Participant; iceServers: IceServer[] }
  | { status: 'refused'; error: AppError }
  | { status: 'ended' }
  | { status: 'displaced' };

export interface RoomActivity {
  id: number;
  text: string;
}

const joinAckSchema = ackSchema(roomJoinResultSchema);

const LEFT_WORDING: Record<PeerLeftReason, string> = {
  left: 'left',
  disconnected: 'lost connection',
  timeout: 'dropped out',
  displaced: 'switched devices',
  ended: 'left',
};

/**
 * Joins a room over the shared socket and keeps a live participant list.
 *
 * Participants are keyed by userId (one seat per person). A peer-left is
 * applied only if its peerId matches the seat we hold, because when someone
 * switches tabs the server announces "old tab left" after "new tab joined"
 * may already have arrived.
 */
export function useRoom(slug: string) {
  const socket = useSocket();
  const [state, setState] = useState<RoomState>({ status: 'connecting' });
  const [participants, setParticipants] = useState<Map<string, Participant>>(new Map());
  const [activity, setActivity] = useState<RoomActivity | null>(null);
  const joinedRef = useRef(false);
  const activityId = useRef(0);
  // Mirror of `participants` for event handlers, so they can read the current
  // seat without doing side effects inside a state updater (React may run
  // updaters twice in development).
  const participantsRef = useRef(participants);
  participantsRef.current = participants;

  const announce = useCallback((text: string) => {
    activityId.current += 1;
    setActivity({ id: activityId.current, text });
  }, []);

  const join = useCallback(async () => {
    if (!socket?.connected) return;
    setState((s) => (s.status === 'joined' ? s : { status: 'joining' }));
    try {
      const raw: unknown = await socket.timeout(10_000).emitWithAck('room:join', { slug });
      const result = joinAckSchema.parse(raw);
      if (result.ok) {
        joinedRef.current = true;
        setState({
          status: 'joined',
          room: result.data.room,
          self: result.data.self,
          iceServers: result.data.iceServers,
        });
      } else {
        joinedRef.current = false;
        setState(
          result.error.code === 'ROOM_ENDED'
            ? { status: 'ended' }
            : { status: 'refused', error: result.error },
        );
      }
    } catch {
      setState({
        status: 'refused',
        error: { code: 'INTERNAL', message: 'The server did not answer. Try again.' },
      });
    }
  }, [socket, slug]);

  useEffect(() => {
    if (!socket) return;

    const onParticipants = (e: { slug: string; participants: Participant[] }) => {
      if (e.slug !== slug) return;
      setParticipants(new Map(e.participants.map((p) => [p.userId, p])));
    };
    const onJoined = (e: { slug: string; participant: Participant }) => {
      if (e.slug !== slug) return;
      setParticipants((prev) => new Map(prev).set(e.participant.userId, e.participant));
      announce(`${e.participant.displayName} joined`);
    };
    const onLeft = (e: {
      slug: string;
      userId: string;
      peerId: string;
      reason: PeerLeftReason;
    }) => {
      if (e.slug !== slug) return;
      const seat = participantsRef.current.get(e.userId);
      if (seat?.peerId === e.peerId && e.reason !== 'displaced') {
        announce(`${seat.displayName} ${LEFT_WORDING[e.reason]}`);
      }
      setParticipants((prev) => {
        if (prev.get(e.userId)?.peerId !== e.peerId) return prev;
        const next = new Map(prev);
        next.delete(e.userId);
        return next;
      });
    };
    const onMedia = (e: { slug: string; userId: string; peerId: string; media: MediaState }) => {
      if (e.slug !== slug) return;
      setParticipants((prev) => {
        const seat = prev.get(e.userId);
        if (seat?.peerId !== e.peerId) return prev;
        return new Map(prev).set(e.userId, { ...seat, media: e.media });
      });
    };
    const onUpdated = (e: { slug: string; name: string; isLocked: boolean }) => {
      if (e.slug !== slug) return;
      setState((s) =>
        s.status === 'joined'
          ? { ...s, room: { ...s.room, name: e.name, isLocked: e.isLocked } }
          : s,
      );
      announce(e.isLocked ? 'The host locked the meeting' : 'The host unlocked the meeting');
    };
    const onEnded = (e: { slug: string }) => {
      if (e.slug !== slug) return;
      joinedRef.current = false;
      setState({ status: 'ended' });
    };
    const onDisplaced = (e: { slug: string }) => {
      if (e.slug !== slug) return;
      joinedRef.current = false;
      setState({ status: 'displaced' });
    };
    // A reconnect is a new socket as far as the server is concerned: our seat
    // was released when the old one dropped, so take it again.
    const onConnect = () => {
      void join();
    };

    socket.on('room:participants', onParticipants);
    socket.on('room:peer-joined', onJoined);
    socket.on('room:peer-left', onLeft);
    socket.on('room:updated', onUpdated);
    socket.on('room:peer-media', onMedia);
    socket.on('room:ended', onEnded);
    socket.on('room:displaced', onDisplaced);
    socket.on('connect', onConnect);
    if (socket.connected) void join();

    return () => {
      socket.off('room:participants', onParticipants);
      socket.off('room:peer-joined', onJoined);
      socket.off('room:peer-left', onLeft);
      socket.off('room:updated', onUpdated);
      socket.off('room:peer-media', onMedia);
      socket.off('room:ended', onEnded);
      socket.off('room:displaced', onDisplaced);
      socket.off('connect', onConnect);
      if (joinedRef.current && socket.connected) {
        joinedRef.current = false;
        void socket.emitWithAck('room:leave', { slug });
      }
    };
  }, [socket, slug, join, announce]);

  const ordered = [...participants.values()].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));

  return { state, participants: ordered, activity, rejoin: join };
}
