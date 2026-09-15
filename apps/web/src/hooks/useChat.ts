import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ackSchema,
  chatHistoryResponseSchema,
  chatMessageSchema,
  chatPlaintextSchema,
  type ChatMessage,
  type Participant,
} from '@confluence/shared';
import { ApiError, request } from '../lib/api';
import { loadE2E } from '../lib/e2e';
import { useSocket } from '../lib/realtime-context';

/**
 * The room's chat, end-to-end encrypted with the room key. Each message is
 * bound to the room, its sender and its id (see packages/shared chat.ts), so
 * a message shown as Ada's was encrypted by someone holding the room key and
 * claiming to be Ada, and the server cannot have re-attributed it.
 */

export interface ChatEntry {
  id: string;
  sender: ChatMessage['sender'];
  /** Null if it could not be decrypted (sent under a room key since lost). */
  text: string | null;
  createdAt: string;
  status: 'sent' | 'sending' | 'failed';
}

const sendAck = ackSchema(chatMessageSchema);
const context = (slug: string, senderId: string, id: string) =>
  `confluence/chat/v1/${slug}/${senderId}/${id}`;

async function open(slug: string, roomKey: Uint8Array, m: ChatMessage): Promise<ChatEntry> {
  let text: string | null = null;
  try {
    const e2e = await loadE2E();
    const plain = await e2e.decryptText(
      m.ciphertext,
      roomKey,
      context(slug, m.sender.userId, m.id),
    );
    text = chatPlaintextSchema.parse(JSON.parse(plain)).text;
  } catch {
    text = null;
  }
  return { id: m.id, sender: m.sender, text, createdAt: m.createdAt, status: 'sent' };
}

function merge(existing: ChatEntry[], incoming: ChatEntry[]): ChatEntry[] {
  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  // Pending messages have no server time yet: keep them at the end.
  return [...byId.values()].sort((a, b) =>
    a.status === 'sending' && b.status !== 'sending'
      ? 1
      : b.status === 'sending' && a.status !== 'sending'
        ? -1
        : a.createdAt.localeCompare(b.createdAt),
  );
}

export function useChat(slug: string, roomKey: Uint8Array | null, self: Participant) {
  const socket = useSocket();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const loadedOnce = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const visible = useRef(false);

  // Latest page, again after every rejoin (a new peer id), so nothing sent
  // while we were disconnected is missed.
  useEffect(() => {
    if (!roomKey) return;
    let cancelled = false;
    request(`/rooms/${slug}/messages`, { schema: chatHistoryResponseSchema, auth: true })
      .then(async (page) => {
        const opened = await Promise.all(page.messages.map((m) => open(slug, roomKey, m)));
        if (cancelled) return;
        setEntries((prev) => merge(prev, opened));
        // A reload after rejoining must not forget older pages already shown.
        if (!loadedOnce.current) setHasMore(page.hasMore);
        loadedOnce.current = true;
        setLoaded(true);
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof ApiError ? caught.message : 'Could not load the chat.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [slug, roomKey, self.peerId]);

  // Listen even before the room key arrives: a newcomer waiting for someone
  // to share the key must still see that messages are coming in. Those are
  // counted now and shown by the history load that runs once the key is here.
  const keyRef = useRef(roomKey);
  keyRef.current = roomKey;
  useEffect(() => {
    if (!socket) return;
    const onMessage = (e: { slug: string; message: ChatMessage }) => {
      if (e.slug !== slug) return;
      if (!visible.current) setUnread((n) => n + 1);
      const key = keyRef.current;
      if (key)
        void open(slug, key, e.message).then((entry) => setEntries((prev) => merge(prev, [entry])));
    };
    socket.on('chat:message', onMessage);
    return () => {
      socket.off('chat:message', onMessage);
    };
  }, [socket, slug]);

  const loadOlder = useCallback(async () => {
    if (!roomKey) return;
    const first = entries.find((e) => e.status === 'sent');
    try {
      const page = await request(
        `/rooms/${slug}/messages${first ? `?before=${encodeURIComponent(first.id)}` : ''}`,
        { schema: chatHistoryResponseSchema, auth: true },
      );
      const opened = await Promise.all(page.messages.map((m) => open(slug, roomKey, m)));
      setEntries((prev) => merge(prev, opened));
      setHasMore(page.hasMore);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load older messages.');
    }
  }, [slug, roomKey, entries]);

  const deliver = useCallback(
    async (id: string, text: string) => {
      if (!socket || !roomKey) return;
      try {
        const e2e = await loadE2E();
        const ciphertext = await e2e.encryptText(
          JSON.stringify({ text }),
          roomKey,
          context(slug, self.userId, id),
        );
        const result = sendAck.parse(
          await socket.timeout(10_000).emitWithAck('chat:send', { slug, id, ciphertext }),
        );
        if (!result.ok) throw new ApiError(0, result.error.code, result.error.message);
        setEntries((prev) => merge(prev, [{ ...result.data, text, status: 'sent' }]));
      } catch (caught) {
        setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, status: 'failed' } : e)));
        if (caught instanceof ApiError && caught.code === 'RATE_LIMITED') {
          setError('You are sending messages too quickly.');
        }
      }
    },
    [socket, slug, roomKey, self.userId],
  );

  /** Shows the message at once; it turns solid when the server confirms it. */
  const send = useCallback(
    (text: string) => {
      const id = crypto.randomUUID();
      const pending: ChatEntry = {
        id,
        sender: { userId: self.userId, displayName: self.displayName },
        text,
        createdAt: new Date().toISOString(),
        status: 'sending',
      };
      setError(null);
      setEntries((prev) => merge(prev, [pending]));
      void deliver(id, text);
    },
    [deliver, self.userId, self.displayName],
  );

  /** Same id: the server recognises a retry and never posts it twice. */
  const retry = useCallback(
    (entry: ChatEntry) => {
      if (!entry.text) return;
      setEntries((prev) => prev.map((e) => (e.id === entry.id ? { ...e, status: 'sending' } : e)));
      void deliver(entry.id, entry.text);
    },
    [deliver],
  );

  /** The chat is on screen: nothing counts as unread while it is. */
  const setVisible = useCallback((on: boolean) => {
    visible.current = on;
    if (on) setUnread(0);
  }, []);

  return { entries, hasMore, loaded, error, unread, send, retry, loadOlder, setVisible };
}
