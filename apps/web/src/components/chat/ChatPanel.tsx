import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MAX_CHAT_LENGTH } from '@confluence/shared';
import type { ChatEntry, useChat } from '../../hooks/useChat';
import type { RoomKeyState } from '../../hooks/useRoomKey';
import { KeyStatus } from '../keys/KeyStatus';
import { SafetyCodes } from '../keys/SafetyCodes';
import { Alert, Button, Spinner } from '../ui';
import { CloseIcon } from '../call/icons';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

interface ChatPanelProps {
  slug: string;
  selfUserId: string;
  roomKey: RoomKeyState;
  chat: ReturnType<typeof useChat>;
  onClose: () => void;
}

export function ChatPanel({ slug, selfUserId, roomKey, chat, onClose }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const stickToBottom = useRef(true);
  const headingId = useId();
  const ready = roomKey.status === 'ready';

  // Follow new messages, unless the reader has scrolled up to read history.
  useEffect(() => {
    const el = list.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.entries]);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || !ready) return;
    stickToBottom.current = true;
    chat.send(text.slice(0, MAX_CHAT_LENGTH));
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex h-full flex-col gap-3 rounded-2xl border border-edge bg-surface-raised p-4"
    >
      <div className="flex items-center justify-between">
        <h2 id={headingId} className="text-sm font-semibold">
          Chat
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close chat"
          className="rounded-md p-1 text-ink-muted hover:bg-surface-sunken hover:text-ink"
        >
          <CloseIcon />
        </button>
      </div>

      <KeyStatus
        state={roomKey}
        userId={selfUserId}
        readyText="End-to-end encrypted. Only people in this meeting can read these messages."
        waitingText="Chat is end-to-end encrypted. It opens once someone who already has this room’s key is in the call with you; they share it automatically."
      />
      {chat.error && <Alert tone="warning">{chat.error}</Alert>}

      <ol
        ref={list}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="flex min-h-40 flex-1 flex-col gap-3 overflow-y-auto"
      >
        {ready && chat.hasMore && (
          <li className="text-center">
            <button
              type="button"
              className="text-xs font-medium text-accent hover:underline"
              onClick={() => {
                stickToBottom.current = false;
                void chat.loadOlder();
              }}
            >
              Load earlier messages
            </button>
          </li>
        )}
        {ready && !chat.loaded && (
          <li className="text-center">
            <Spinner label="Loading messages" />
          </li>
        )}
        {ready && chat.loaded && chat.entries.length === 0 && (
          <li className="text-center text-sm text-ink-muted">No messages yet. Say hello.</li>
        )}
        {chat.entries.map((entry) => (
          <Message
            key={entry.id}
            entry={entry}
            mine={entry.sender.userId === selfUserId}
            onRetry={() => chat.retry(entry)}
          />
        ))}
      </ol>

      <form onSubmit={submit} className="flex items-end gap-2">
        <textarea
          aria-label="Message"
          placeholder={ready ? 'Message everyone' : 'Waiting for encryption…'}
          value={draft}
          maxLength={MAX_CHAT_LENGTH}
          rows={Math.min(4, Math.max(1, draft.split('\n').length))}
          disabled={!ready}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 resize-none rounded-lg border border-edge-strong bg-surface-raised px-3 py-2 text-sm text-ink placeholder:text-ink-muted/70 disabled:opacity-60"
        />
        <Button type="submit" disabled={!ready || draft.trim() === ''} className="px-3 py-2">
          Send
        </Button>
      </form>

      {ready && <SafetyCodes slug={slug} selfUserId={selfUserId} />}
    </section>
  );
}

function Message({
  entry,
  mine,
  onRetry,
}: {
  entry: ChatEntry;
  mine: boolean;
  onRetry: () => void;
}) {
  return (
    <li className={`flex flex-col gap-0.5 ${mine ? 'items-end' : 'items-start'}`}>
      <span className="text-xs text-ink-muted">
        {mine ? 'You' : entry.sender.displayName}
        {entry.status === 'sent' && ` · ${time(entry.createdAt)}`}
      </span>
      <p
        className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap ${
          mine ? 'bg-accent text-accent-ink' : 'bg-surface-sunken'
        } ${entry.status === 'sending' ? 'opacity-60' : ''}`}
      >
        {entry.text ?? <em className="opacity-80">This message could not be decrypted.</em>}
      </p>
      {entry.status === 'failed' && (
        <span className="text-xs text-down">
          Not sent.{' '}
          <button type="button" className="font-medium underline" onClick={onRetry}>
            Retry
          </button>
        </span>
      )}
    </li>
  );
}
