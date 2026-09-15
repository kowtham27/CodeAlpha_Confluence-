import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { MAX_CHAT_LENGTH } from '@confluence/shared';
import type { ChatEntry, useChat } from '../../hooks/useChat';
import type { RoomKeyState } from '../../hooks/useRoomKey';
import { SidePanel } from '../call/SidePanel';
import { KeyStatus } from '../keys/KeyStatus';
import { SafetyCodes } from '../keys/SafetyCodes';
import { Alert, Spinner } from '../ui';

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const SendIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
    <path d="M3.4 20.4 21 12 3.4 3.6l-.1 6.5L15 12 3.3 13.9z" />
  </svg>
);

interface ChatPanelProps {
  slug: string;
  selfUserId: string;
  roomKey: RoomKeyState;
  chat: ReturnType<typeof useChat>;
  onClose: () => void;
}

/**
 * In-call messages, styled after the calm, bubble-less chat of Meet: a
 * name and time over each run of messages, text at reading size, and one
 * rounded composer at the bottom.
 */
export function ChatPanel({ slug, selfUserId, roomKey, chat, onClose }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
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
    <SidePanel title="Chat" closeLabel="Close chat" onClose={onClose} scroll={false}>
      <div className="flex flex-col gap-3">
        <KeyStatus
          state={roomKey}
          userId={selfUserId}
          readyText="End-to-end encrypted. Only people in this meeting can read these messages."
          waitingText="Chat is end-to-end encrypted. It opens once someone who already has this room’s key is in the call with you; they share it automatically."
        />
        {ready && <SafetyCodes slug={slug} selfUserId={selfUserId} />}
        {chat.error && <Alert tone="warning">{chat.error}</Alert>}
      </div>

      {/* The log wraps the list: role="log" on the <ol> itself would strip its
          list semantics and orphan every message. */}
      <div
        ref={list}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="-mx-2 min-h-32 flex-1 overflow-y-auto px-2"
      >
        <ol className="flex flex-col gap-4">
          {ready && chat.hasMore && (
            <li className="text-center">
              <button
                type="button"
                className="rounded-full px-3 py-1 text-[13px] font-medium text-accent hover:bg-accent/8"
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
            <li className="pt-6 text-center text-accent">
              <Spinner label="Loading messages" />
            </li>
          )}
          {ready && chat.loaded && chat.entries.length === 0 && (
            <li className="pt-10 text-center text-sm text-ink-muted">
              No messages yet. Say hello.
            </li>
          )}
          {chat.entries.map((entry, i) => (
            <Message
              key={entry.id}
              entry={entry}
              mine={entry.sender.userId === selfUserId}
              // Consecutive messages from one person share a single header.
              continued={chat.entries[i - 1]?.sender.userId === entry.sender.userId}
              onRetry={() => chat.retry(entry)}
            />
          ))}
        </ol>
      </div>

      <form
        onSubmit={submit}
        className="flex shrink-0 items-end gap-1 rounded-3xl bg-surface-sunken py-1.5 pr-1.5 pl-5 focus-within:ring-2 focus-within:ring-accent/40"
      >
        <textarea
          aria-label="Message"
          placeholder={ready ? 'Send a message' : 'Waiting for encryption…'}
          value={draft}
          maxLength={MAX_CHAT_LENGTH}
          rows={Math.min(4, Math.max(1, draft.split('\n').length))}
          disabled={!ready}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 resize-none bg-transparent py-2 text-sm leading-5 text-ink placeholder:text-ink-muted focus:outline-none focus-visible:outline-none disabled:opacity-60"
        />
        <button
          type="submit"
          aria-label="Send message"
          title="Send message"
          disabled={!ready || draft.trim() === ''}
          className="flex size-9 shrink-0 items-center justify-center rounded-full text-accent transition-colors hover:bg-accent/10 disabled:text-ink-muted/50 disabled:hover:bg-transparent"
        >
          <SendIcon />
        </button>
      </form>
    </SidePanel>
  );
}

function Message({
  entry,
  mine,
  continued,
  onRetry,
}: {
  entry: ChatEntry;
  mine: boolean;
  continued: boolean;
  onRetry: () => void;
}) {
  return (
    <li className={`flex flex-col gap-0.5 ${continued ? '-mt-3' : ''}`}>
      {!continued && (
        <span className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium">{mine ? 'You' : entry.sender.displayName}</span>
          {entry.status === 'sent' && (
            <span className="text-xs text-ink-muted">{time(entry.createdAt)}</span>
          )}
        </span>
      )}
      <p
        className={`text-sm leading-5 break-words whitespace-pre-wrap ${
          entry.status === 'sending' ? 'text-ink-muted' : ''
        }`}
      >
        {entry.text ?? <em className="text-ink-muted">This message could not be decrypted.</em>}
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
