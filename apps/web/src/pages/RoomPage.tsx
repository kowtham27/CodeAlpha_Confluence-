import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type {
  AppError,
  IceServer,
  Participant,
  RoomSummary,
  ScreenSharer,
} from '@confluence/shared';
import { WhiteboardIcon } from '../components/board/icons';
import { Whiteboard } from '../components/board/Whiteboard';
import { CallControls } from '../components/call/CallControls';
import { ChatIcon, InfoIcon, LockIcon, PaperclipIcon } from '../components/call/icons';
import { Lobby } from '../components/call/Lobby';
import { CopyInvite, MeetingDetails } from '../components/call/MeetingDetails';
import { PresentationStage } from '../components/call/PresentationStage';
import { VideoTile } from '../components/call/VideoTile';
import { ChatPanel } from '../components/chat/ChatPanel';
import { FilesPanel } from '../components/files/FilesPanel';
import { KeyStatus } from '../components/keys/KeyStatus';
import { ShortcutsDialog } from '../components/ShortcutsDialog';
import { Button, FullPageSpinner, Logo } from '../components/ui';
import { useBoardSession, useBoardVersion } from '../hooks/useBoard';
import { canShareScreen, useCall } from '../hooks/useCall';
import { useCallShortcuts } from '../hooks/useCallShortcuts';
import { useChat } from '../hooks/useChat';
import { useRoom, type RoomActivity } from '../hooks/useRoom';
import { useRoomFiles } from '../hooks/useRoomFiles';
import { useRoomKey } from '../hooks/useRoomKey';
import { DirectTransfers } from '../lib/files/direct';
import { DEFAULT_PREFERENCES, PROBLEM_TEXT, type JoinPreferences } from '../lib/media/local-media';
import { inviteLink, parseRoomInput } from '../lib/rooms';
import { useAuth } from '../stores/auth';

const REFUSAL_TITLES: Partial<Record<AppError['code'], string>> = {
  NOT_FOUND: 'Room not found',
  ROOM_LOCKED: 'This meeting is locked',
  ROOM_FULL: 'This meeting is full',
  RATE_LIMITED: 'Slow down',
};

/** Full-screen message for every way a join can end without a seat. */
function RoomMessage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface">
      <header className="px-6 py-5 sm:px-8">
        <Logo />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-4 pb-24 text-center">
        <h1 className="text-[28px] leading-9 font-normal tracking-[-0.01em]">{title}</h1>
        <div className="mt-3 max-w-md text-[15px] text-ink-muted">{children}</div>
      </main>
    </div>
  );
}

function BackHome() {
  return (
    <Link
      to="/"
      className="mt-8 inline-flex h-10 items-center rounded-full border border-edge-strong/60 px-6 text-sm font-medium text-accent hover:bg-accent/8"
    >
      Return to home screen
    </Link>
  );
}

export function RoomPage() {
  const { slug: rawSlug = '' } = useParams();
  const slug = parseRoomInput(rawSlug);
  if (!slug) {
    return (
      <RoomMessage title="Room not found">
        That link does not look right. Check it and try again.
        <br />
        <BackHome />
      </RoomMessage>
    );
  }
  return <Room slug={slug} />;
}

function Room({ slug }: { slug: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Someone who just created the room goes straight in; everyone else, and
  // any reload, sees the lobby first.
  const created = (location.state as { created?: boolean } | null)?.created === true;
  const [preferences, setPreferences] = useState<JoinPreferences | null>(
    created ? DEFAULT_PREFERENCES : null,
  );
  useEffect(() => {
    // History keeps navigation state across reloads: consume it once.
    if (created) void navigate(location.pathname, { replace: true, state: null });
  }, [created, navigate, location.pathname]);
  const { state, participants, activity, rejoin } = useRoom(slug, preferences !== null);
  const realtime = useAuth((s) => s.realtime);

  if (!preferences) {
    return (
      <Lobby
        slug={slug}
        onJoin={setPreferences}
        renderMessage={(title, message) => (
          <RoomMessage title={title}>
            {message}
            <br />
            <BackHome />
          </RoomMessage>
        )}
      />
    );
  }

  if (state.status === 'connecting' || state.status === 'joining') {
    return <FullPageSpinner label="Joining the meeting" />;
  }

  if (state.status === 'ended') {
    return (
      <RoomMessage title="This meeting has ended">
        The host ended the meeting for everyone.
        <br />
        <BackHome />
      </RoomMessage>
    );
  }

  if (state.status === 'displaced') {
    return (
      <RoomMessage title="You joined from somewhere else">
        This meeting is open in another tab or device. You can only be in it once.
        <div className="mt-8 flex justify-center gap-3">
          <Button onClick={() => void rejoin()}>Use this tab instead</Button>
        </div>
      </RoomMessage>
    );
  }

  if (state.status === 'refused') {
    return (
      <RoomMessage title={REFUSAL_TITLES[state.error.code] ?? 'Could not join'}>
        {state.error.message}
        <br />
        <BackHome />
      </RoomMessage>
    );
  }

  return (
    <InCall
      preferences={preferences}
      room={state.room}
      self={state.self}
      iceServers={state.iceServers}
      screen={state.screen}
      participants={participants}
      activity={activity}
      realtimeOnline={realtime === 'online'}
      onLeave={() => void navigate('/')}
    />
  );
}

function useWide(): boolean {
  const query = '(min-width: 768px)';
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setWide(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, []);
  return wide;
}

/** Spec: adaptive grid for 1, 2, 4 and 6 tiles. Every tile fills its cell. */
function gridShape(count: number, wide: boolean): { cols: number; rows: number } {
  if (count <= 1) return { cols: 1, rows: 1 };
  if (!wide) return count <= 2 ? { cols: 1, rows: count } : { cols: 2, rows: Math.ceil(count / 2) };
  if (count === 2) return { cols: 2, rows: 1 };
  if (count <= 4) return { cols: 2, rows: 2 };
  return { cols: 3, rows: Math.ceil(count / 3) };
}

/** "10:42", as in the corner of a meeting. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="tabular-nums">
      {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
    </span>
  );
}

/** Who joined or left: shown for a few seconds, and spoken by screen readers. */
function ActivityToast({ activity }: { activity: RoomActivity | null }) {
  const [shown, setShown] = useState<RoomActivity | null>(null);
  useEffect(() => {
    if (!activity) return;
    setShown(activity);
    const t = setTimeout(() => setShown(null), 6_000);
    return () => clearTimeout(t);
  }, [activity]);
  return (
    // Centred at the foot of the stage, clear of the name labels at each
    // tile's bottom-left corner.
    <div
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center"
    >
      {shown && (
        <p
          key={shown.id}
          className="animate-[toast-in_180ms_ease-out] rounded-xl bg-stage-ink px-4 py-3 text-sm text-stage shadow-lg"
        >
          {shown.text}
        </p>
      )}
    </div>
  );
}

/** A notice pinned to the top of the stage: light on dark, so it cannot be missed. */
function Banner({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="pointer-events-auto max-w-xl animate-[toast-in_180ms_ease-out] rounded-2xl bg-stage-ink px-4 py-2.5 text-center text-sm text-stage shadow-lg"
    >
      {children}
    </div>
  );
}

/** A panel toggle on the right of the call bar, with an optional count or dot. */
function StageToggle({
  label,
  title,
  on,
  badge,
  onClick,
  children,
  controls,
  pressed,
}: {
  label: string;
  title: string;
  on: boolean;
  badge?: number | 'dot';
  onClick: () => void;
  children: ReactNode;
  /** Panels are expanded; the whiteboard is pressed. */
  controls?: string;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      aria-expanded={controls ? on : undefined}
      aria-controls={controls}
      aria-pressed={pressed}
      onClick={onClick}
      className={`relative flex size-12 items-center justify-center rounded-full transition-colors ${
        on ? 'bg-stage-accent text-stage' : 'text-stage-ink hover:bg-stage-raised'
      }`}
    >
      {children}
      {badge === 'dot' && (
        <span
          aria-hidden="true"
          className="absolute top-2 right-2 size-2.5 rounded-full bg-stage-accent ring-2 ring-stage"
        />
      )}
      {typeof badge === 'number' && badge > 0 && (
        <span
          aria-hidden="true"
          className="absolute top-1 right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-stage-accent px-1 text-[11px] font-medium text-stage ring-2 ring-stage"
        >
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

interface InCallProps {
  preferences: JoinPreferences;
  room: RoomSummary;
  self: Participant;
  iceServers: IceServer[];
  screen: ScreenSharer | null;
  participants: Participant[];
  activity: RoomActivity | null;
  realtimeOnline: boolean;
  onLeave: () => void;
}

type PanelName = 'details' | 'chat' | 'files';

function InCall({
  preferences,
  room,
  self,
  iceServers,
  screen,
  participants,
  activity,
  realtimeOnline,
  onLeave,
}: InCallProps) {
  // One per call: lives as long as the connections whose channels it serves.
  const [direct] = useState(() => new DirectTransfers());
  useEffect(() => () => direct.close(), [direct]);
  const call = useCall({
    slug: room.slug,
    self,
    iceServers,
    participants,
    onDataChannel: (peerId, channel) => direct.attach(peerId, channel),
    preferences,
  });
  const roomKey = useRoomKey(
    room.slug,
    participants.map((p) => p.userId),
  );
  const readyKey = roomKey.status === 'ready' ? roomKey.roomKey : null;
  const files = useRoomFiles(room.slug, readyKey);
  const board = useBoardSession(room.slug, readyKey, self, participants);
  useBoardVersion(board);
  const [boardOpen, setBoardOpen] = useState(false);
  // Looking at the board counts as having seen every change on it.
  useEffect(() => {
    if (boardOpen) board?.markSeen();
  });
  const boardUnseen = boardOpen ? 0 : (board?.unseen ?? 0);
  const chat = useChat(room.slug, readyKey, self);
  // The side panel shows one of details, chat or files (or nothing).
  const [panel, setPanel] = useState<PanelName | null>(null);
  const filesOpen = panel === 'files';
  const { setVisible: setChatVisible } = chat;
  useEffect(() => setChatVisible(panel === 'chat'), [panel, setChatVisible]);
  const [seenAt, setSeenAt] = useState(() => new Date().toISOString());
  const { transfers } = useSyncExternalStore(direct.subscribe, direct.getSnapshot);
  // Files that arrived from others since the files panel was last looked at.
  const unseen = filesOpen
    ? 0
    : files.files.filter(
        (f) => f.summary.createdAt > seenAt && f.summary.uploader.userId !== self.userId,
      ).length +
      transfers.filter((t) => t.direction === 'in' && t.startedAt > Date.parse(seenAt)).length;

  function togglePanel(which: PanelName): void {
    if (panel === 'files' || which === 'files') setSeenAt(new Date().toISOString());
    setPanel((open) => (open === which ? null : which));
  }
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  // Only trust a presenter who is actually in the participant list.
  const presenter = screen && participants.some((p) => p.peerId === screen.peerId) ? screen : null;

  async function toggleShare(): Promise<void> {
    setShareError(null);
    if (call.sharing) {
      await call.stopShare();
      return;
    }
    setShareError(await call.startShare());
  }
  const onPlaybackBlocked = useCallback(() => setSoundBlocked(true), []);
  const isHost = room.myRole === 'OWNER' || room.myRole === 'MODERATOR';
  // The board or a presentation takes the stage; the videos become a filmstrip.
  const stageInUse = boardOpen || presenter !== null;
  const wide = useWide();

  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  useCallShortcuts({
    m: call.toggleAudio,
    v: call.toggleVideo,
    s: () => {
      if (canShareScreen()) void toggleShare();
    },
    c: () => togglePanel('chat'),
    f: () => togglePanel('files'),
    b: () => setBoardOpen((open) => !open),
    '?': () => setShortcutsOpen(true),
  });

  // Our own tile reflects local state immediately, not the server round trip.
  const tiles = participants.map((p) =>
    p.userId === self.userId ? { ...p, media: call.enabled } : p,
  );
  const alone = participants.length === 1 && !stageInUse;
  const shape = gridShape(tiles.length, wide);

  const problems = (['audio', 'video'] as const)
    .filter((kind) => call.problems[kind])
    .map(
      (kind) =>
        `${kind === 'audio' ? 'Microphone' : 'Camera'} ${PROBLEM_TEXT[call.problems[kind] ?? 'failed']}.`,
    );

  const tileList = (
    <ul
      aria-label="Participants"
      className={
        stageInUse
          ? 'flex shrink-0 gap-2 overflow-x-auto lg:w-60 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto'
          : 'grid size-full gap-2'
      }
      style={
        stageInUse
          ? undefined
          : {
              gridTemplateColumns: `repeat(${shape.cols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${shape.rows}, minmax(0, 1fr))`,
            }
      }
    >
      {tiles.map((p) => (
        <VideoTile
          key={p.userId}
          participant={p}
          isSelf={p.userId === self.userId}
          stream={
            p.userId === self.userId ? call.localStream : (call.remoteStreams.get(p.peerId) ?? null)
          }
          connection={call.peerStates.get(p.peerId)}
          quality={call.quality.get(p.peerId)}
          speaking={call.speakingUserId === p.userId}
          onPlaybackBlocked={onPlaybackBlocked}
          compact={stageInUse}
          hideVideo={presenter?.peerId === p.peerId}
        />
      ))}
    </ul>
  );

  return (
    <div className="stage flex h-dvh flex-col overflow-hidden bg-stage text-stage-ink">
      <div className="flex min-h-0 flex-1 gap-3 p-3 pb-1 sm:p-4 sm:pb-1">
        <main className="relative flex min-w-0 flex-1 flex-col">
          {/* Notices sit over the top of the stage, never pushing it around. */}
          <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex flex-col items-center gap-2 px-4">
            {!realtimeOnline && (
              <Banner>Connection lost. Reconnecting… you will rejoin automatically.</Banner>
            )}
            {room.isLocked && !isHost && (
              <Banner>The host has locked this meeting. No one new can join.</Banner>
            )}
            {problems.length > 0 && (
              <Banner>
                {problems.join(' ')} Others can still see and hear the rest of the meeting.
              </Banner>
            )}
            {shareError && <Banner>{shareError}</Banner>}
            {soundBlocked && (
              <Banner>
                Your browser paused the meeting audio.{' '}
                <button
                  type="button"
                  className="font-medium text-[#0b57d0] underline-offset-2 hover:underline"
                  onClick={() => {
                    for (const v of document.querySelectorAll('video')) void v.play();
                    setSoundBlocked(false);
                  }}
                >
                  Turn on sound
                </button>
              </Banner>
            )}
          </div>

          {stageInUse ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
              <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
                {boardOpen &&
                  (board ? (
                    <Whiteboard
                      session={board}
                      isHost={isHost}
                      participants={participants}
                      presenterName={
                        presenter && presenter.userId !== self.userId ? presenter.displayName : null
                      }
                      onShowPresentation={() => setBoardOpen(false)}
                      onClose={() => setBoardOpen(false)}
                    />
                  ) : (
                    <section
                      aria-label="Whiteboard"
                      className="flex w-full max-w-lg flex-col gap-3 rounded-2xl bg-surface-raised p-6 text-ink ring-1 ring-edge"
                    >
                      <KeyStatus
                        state={roomKey}
                        userId={self.userId}
                        readyText="End-to-end encrypted."
                        waitingText="The whiteboard is end-to-end encrypted. It opens once someone who already has this room’s key is in the call with you; they share it automatically."
                      />
                    </section>
                  ))}
                {presenter && !boardOpen && (
                  <PresentationStage
                    sharer={presenter}
                    isSelf={presenter.userId === self.userId}
                    stream={call.remoteStreams.get(presenter.peerId) ?? null}
                    onStop={() => void toggleShare()}
                  />
                )}
              </div>
              {tileList}
            </div>
          ) : alone ? (
            <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-h-0">{tileList}</div>
              <section
                aria-labelledby="alone-title"
                className="flex flex-col justify-center gap-4 self-center rounded-2xl bg-surface-raised p-6 text-ink ring-1 ring-edge"
              >
                <h2 id="alone-title" className="text-[22px] font-normal">
                  Your meeting’s ready
                </h2>
                <p className="text-sm text-ink-muted">
                  You are the only one here. Share this link with the people you want in the
                  meeting.
                </p>
                <p className="rounded-xl bg-surface-sunken px-4 py-3 text-[13px] break-all select-all">
                  {inviteLink(room.slug)}
                </p>
                <div>
                  <CopyInvite slug={room.slug} tone="tonal" />
                </div>
                <p className="flex items-center gap-2 text-xs text-ink-muted">
                  <LockIcon size={14} /> Chat, files and the whiteboard are end-to-end encrypted.
                </p>
              </section>
            </div>
          ) : (
            <div className="min-h-0 flex-1">{tileList}</div>
          )}

          <ActivityToast activity={activity} />
        </main>

        {/* Full-screen on phones, a card beside the stage from md up.
            Unmounted while closed: the hooks above own all state. */}
        {panel && (
          <aside
            id="side-panel"
            className="fixed inset-2 z-30 md:relative md:inset-auto md:z-auto md:w-[360px] md:shrink-0"
          >
            {panel === 'details' && (
              <MeetingDetails
                room={room}
                participants={tiles}
                selfUserId={self.userId}
                isHost={isHost}
                onClose={() => setPanel(null)}
              />
            )}
            {panel === 'chat' && (
              <ChatPanel
                slug={room.slug}
                selfUserId={self.userId}
                roomKey={roomKey}
                chat={chat}
                onClose={() => setPanel(null)}
              />
            )}
            {panel === 'files' && (
              <FilesPanel
                selfUserId={self.userId}
                isHost={isHost}
                participants={participants}
                roomKey={roomKey}
                files={files}
                direct={direct}
                onClose={() => togglePanel('files')}
              />
            )}
          </aside>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 py-3 md:grid md:grid-cols-[1fr_auto_1fr] md:px-6">
        <div className="hidden min-w-0 md:block">
          <p className="flex min-w-0 items-center gap-3 text-[15px]">
            <Clock />
            <span aria-hidden="true" className="h-4 w-px shrink-0 bg-stage-hover" />
            <h1 className="truncate font-normal">{room.name}</h1>
            {room.isLocked && (
              <span className="flex shrink-0 items-center gap-1 rounded-full bg-stage-raised px-2 py-0.5 text-xs text-stage-ink">
                <LockIcon size={12} /> Locked
              </span>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-stage-muted">
            {participants.length} of {room.maxParticipants} people · hosted by{' '}
            {room.owner.displayName}
          </p>
        </div>

        <CallControls
          enabled={call.enabled}
          available={call.available}
          devices={call.devices}
          selectedDevice={call.selectedDevice}
          onToggleAudio={call.toggleAudio}
          onToggleVideo={call.toggleVideo}
          onSwitchDevice={call.switchDevice}
          onLeave={onLeave}
          canShare={canShareScreen()}
          sharing={call.sharing}
          presenterName={presenter && !call.sharing ? presenter.displayName : null}
          onToggleShare={() => void toggleShare()}
          onShowShortcuts={() => setShortcutsOpen(true)}
        />

        <div className="flex items-center justify-end gap-1">
          <StageToggle
            label="Meeting details"
            title="Meeting details"
            on={panel === 'details'}
            controls="side-panel"
            onClick={() => togglePanel('details')}
          >
            <InfoIcon />
          </StageToggle>
          <StageToggle
            label={`Chat${chat.unread > 0 ? ` ${chat.unread} unread` : ''}`}
            title="Chat with everyone (C)"
            on={panel === 'chat'}
            controls="side-panel"
            badge={chat.unread}
            onClick={() => togglePanel('chat')}
          >
            <ChatIcon />
          </StageToggle>
          <StageToggle
            label={`Files${unseen > 0 ? ` ${unseen} new` : ''}`}
            title="Files (F)"
            on={filesOpen}
            controls="side-panel"
            badge={unseen}
            onClick={() => togglePanel('files')}
          >
            <PaperclipIcon />
          </StageToggle>
          <StageToggle
            label={`Whiteboard${boardUnseen > 0 ? ' (new changes)' : ''}`}
            title="Whiteboard (B)"
            on={boardOpen}
            pressed={boardOpen}
            {...(boardUnseen > 0 ? { badge: 'dot' as const } : {})}
            onClick={() => setBoardOpen((open) => !open)}
          >
            <WhiteboardIcon />
          </StageToggle>
        </div>
      </footer>
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
