import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  BOARD_COLORS,
  BOARD_HEIGHT,
  BOARD_WIDTH,
  type BoardColor,
  type BoardElement,
  type Participant,
} from '@confluence/shared';
import { useBoardVersion } from '../../hooks/useBoard';
import { hitTest, simplify } from '../../lib/board/geometry';
import { BOARD_BACKGROUND, TEXT_FONT, drawCursor, drawElement } from '../../lib/board/render';
import type { BoardSession } from '../../lib/board/session';
import { saveBlob } from '../../lib/files/save';
import { Alert, Button, Spinner } from '../ui';
import { CloseIcon } from '../call/icons';
import {
  ArrowIcon,
  EllipseIcon,
  EraserIcon,
  ExportIcon,
  LineIcon,
  PenIcon,
  RectIcon,
  RedoIcon,
  TextIcon,
  UndoIcon,
} from './icons';

type Tool = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'eraser';

const TOOLS: { tool: Tool; label: string; key: string; icon: ReactNode }[] = [
  { tool: 'pen', label: 'Pen', key: 'p', icon: <PenIcon /> },
  { tool: 'line', label: 'Line', key: 'l', icon: <LineIcon /> },
  { tool: 'arrow', label: 'Arrow', key: 'a', icon: <ArrowIcon /> },
  { tool: 'rect', label: 'Rectangle', key: 'r', icon: <RectIcon /> },
  { tool: 'ellipse', label: 'Ellipse', key: 'o', icon: <EllipseIcon /> },
  { tool: 'text', label: 'Text', key: 't', icon: <TextIcon /> },
  { tool: 'eraser', label: 'Eraser', key: 'e', icon: <EraserIcon /> },
];

const COLOR_NAMES: Record<BoardColor, string> = {
  '#1f2937': 'Black',
  '#dc2626': 'Red',
  '#ea580c': 'Orange',
  '#16a34a': 'Green',
  '#2563eb': 'Blue',
  '#9333ea': 'Purple',
};

const WIDTHS = [
  { label: 'Thin', stroke: 2, text: 20 },
  { label: 'Medium', stroke: 5, text: 28 },
  { label: 'Thick', stroke: 12, text: 40 },
] as const;

/** Board units; about a fingertip at typical sizes. */
const ERASER_RADIUS = 10;
const DRAFT_INTERVAL_MS = 60;
const CURSOR_INTERVAL_MS = 50;
/** The schema's per-stroke cap; longer strokes are committed in pieces. */
const MAX_STROKE_COORDS = 8000;
const CURSOR_COLORS = ['#2563eb', '#16a34a', '#9333ea', '#ea580c', '#db2777', '#0891b2'];

const clampX = (v: number) => Math.round(Math.max(-400, Math.min(BOARD_WIDTH + 400, v)));
const clampY = (v: number) => Math.round(Math.max(-400, Math.min(BOARD_HEIGHT + 400, v)));

function colorFor(peerId: string): string {
  let h = 0;
  for (const ch of peerId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length] ?? '#2563eb';
}

/** Shapes smaller than this (board units) were a click, not a drag. */
function degenerate(el: BoardElement): boolean {
  if (el.type === 'stroke' || el.type === 'text') return false;
  return Math.hypot(el.x2 - el.x1, el.y2 - el.y1) < 4;
}

interface Gesture {
  id: string;
  el: BoardElement;
  /** Pen only: every sample, simplified at commit. */
  raw: number[];
}

interface WhiteboardProps {
  session: BoardSession;
  isHost: boolean;
  participants: Participant[];
  /** Someone is presenting while the board is open. */
  presenterName: string | null;
  onShowPresentation: () => void;
  onClose: () => void;
}

export function Whiteboard({
  session,
  isHost,
  participants,
  presenterName,
  onShowPresentation,
  onClose,
}: WhiteboardProps) {
  useBoardVersion(session);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<BoardColor>(BOARD_COLORS[0]);
  const [widthIndex, setWidthIndex] = useState(1);
  const [text, setText] = useState<{ x: number; y: number; value: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [scale, setScale] = useState(0);

  const frame = useRef<HTMLDivElement>(null);
  const baseCanvas = useRef<HTMLCanvasElement>(null);
  const liveCanvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const erasing = useRef<Set<string> | null>(null);
  const lastDraft = useRef(0);
  const lastCursor = useRef(0);
  const liveQueued = useRef(false);
  const people = useRef(participants);
  people.current = participants;

  const width = WIDTHS[widthIndex] ?? WIDTHS[1];
  const ready = session.loaded;

  // ---- sizing: the board keeps its aspect ratio and scales to the frame ----
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setScale(el.clientWidth / BOARD_WIDTH));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const prepare = useCallback(
    (canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null => {
      if (!canvas || scale === 0) return null;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(BOARD_WIDTH * scale * dpr);
      const h = Math.round(BOARD_HEIGHT * scale * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext('2d');
      ctx?.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
      return ctx;
    },
    [scale],
  );

  // ---- committed elements ----------------------------------------------------
  const drawBase = useCallback(() => {
    const ctx = prepare(baseCanvas.current);
    if (!ctx) return;
    ctx.fillStyle = BOARD_BACKGROUND;
    ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    const faded = erasing.current;
    for (const item of session.ordered()) {
      if (item.el) drawElement(ctx, item.el, faded?.has(item.id) ? 0.2 : 1);
    }
  }, [prepare, session]);

  useEffect(() => {
    drawBase();
    return session.subscribe(drawBase);
  }, [drawBase, session]);

  // ---- drafts, cursors and the gesture in progress: one frame at a time ----
  const drawLive = useCallback(() => {
    liveQueued.current = false;
    const ctx = prepare(liveCanvas.current);
    if (!ctx) return;
    ctx.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    for (const drafts of session.drafts.values()) {
      for (const d of drafts.values()) drawElement(ctx, d.el, 0.6);
    }
    if (gesture.current) drawElement(ctx, gesture.current.el);
    for (const [peerId, c] of session.cursors) {
      const name = people.current.find((p) => p.peerId === peerId)?.displayName;
      if (name) drawCursor(ctx, c.x, c.y, name, colorFor(peerId));
    }
  }, [prepare, session]);

  const requestLive = useCallback(() => {
    if (liveQueued.current) return;
    liveQueued.current = true;
    requestAnimationFrame(drawLive);
  }, [drawLive]);

  useEffect(() => {
    drawLive();
    return session.subscribeLive(requestLive);
  }, [drawLive, requestLive, session]);

  // ---- pointer input ----------------------------------------------------------
  function toBoard(e: { clientX: number; clientY: number }): [number, number] {
    const rect = liveCanvas.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return [0, 0];
    return [
      clampX(((e.clientX - rect.left) / rect.width) * BOARD_WIDTH),
      clampY(((e.clientY - rect.top) / rect.height) * BOARD_HEIGHT),
    ];
  }

  function eraseAt(x: number, y: number): void {
    const hits = erasing.current;
    if (!hits) return;
    let added = false;
    for (const item of session.ordered()) {
      if (item.el && !hits.has(item.id) && hitTest(item.el, x, y, ERASER_RADIUS)) {
        hits.add(item.id);
        added = true;
      }
    }
    if (added) drawBase();
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!ready || e.button !== 0) return;
    const [x, y] = toBoard(e);
    if (tool === 'text') {
      e.preventDefault(); // keep focus for the text box that is about to appear
      setText({ x, y, value: '' });
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'eraser') {
      erasing.current = new Set();
      eraseAt(x, y);
      return;
    }
    const id = crypto.randomUUID();
    gesture.current =
      tool === 'pen'
        ? { id, raw: [x, y], el: { type: 'stroke', color, width: width.stroke, points: [x, y] } }
        : {
            id,
            raw: [],
            el: { type: tool, color, width: width.stroke, x1: x, y1: y, x2: x, y2: y },
          };
    requestLive();
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const [x, y] = toBoard(e);
    const now = performance.now();
    if (now - lastCursor.current > CURSOR_INTERVAL_MS) {
      lastCursor.current = now;
      session.sendCursor({ x, y });
    }
    if (erasing.current) {
      eraseAt(x, y);
      return;
    }
    const g = gesture.current;
    if (!g) return;
    if (g.el.type === 'stroke') {
      // Coalesced events: the samples the browser merged into this one event,
      // which is what makes fast strokes smooth instead of polygonal.
      const samples = e.nativeEvent.getCoalescedEvents?.() ?? [e.nativeEvent];
      for (const s of samples.length > 0 ? samples : [e.nativeEvent]) g.raw.push(...toBoard(s));
      g.el = { ...g.el, points: g.raw };
    } else if (g.el.type !== 'text') {
      g.el = { ...g.el, x2: x, y2: y };
    }
    requestLive();
    if (now - lastDraft.current > DRAFT_INTERVAL_MS) {
      lastDraft.current = now;
      const draft = g.el.type === 'stroke' ? { ...g.el, points: simplify(g.raw, 2) } : g.el;
      if (draft.type !== 'stroke' || draft.points.length <= MAX_STROKE_COORDS) {
        session.sendDraft(g.id, draft);
      }
    }
  }

  function finishGesture() {
    const hits = erasing.current;
    if (hits) {
      erasing.current = null;
      if (hits.size > 0) session.erase([...hits]);
      drawBase();
      return;
    }
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    session.sendDraft(g.id, null);
    requestLive();
    if (degenerate(g.el)) return;
    if (g.el.type === 'stroke') {
      const points = simplify(g.raw);
      // A very long stroke goes up in pieces, each within the element limit.
      for (let start = 0; start < points.length; start += MAX_STROKE_COORDS - 2) {
        const chunk = points.slice(start, start + MAX_STROKE_COORDS);
        if (chunk.length >= 2) {
          session.add({ ...g.el, points: chunk }, start === 0 ? g.id : crypto.randomUUID());
        }
      }
      return;
    }
    session.add(g.el, g.id);
  }

  function commitText() {
    const draft = text;
    setText(null);
    const value = draft?.value.trim();
    if (!draft || !value) return;
    session.add({
      type: 'text',
      color,
      size: width.text,
      x: draft.x,
      y: draft.y,
      text: value.slice(0, 500),
    });
  }

  // ---- keyboard: tools and undo, while the board is open --------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) session.redo();
        else session.undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        session.redo();
      } else if (!mod && !e.altKey) {
        const match = TOOLS.find((t) => t.key === e.key.toLowerCase());
        if (match) setTool(match.tool);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  function exportPng() {
    const canvas = document.createElement('canvas');
    canvas.width = BOARD_WIDTH;
    canvas.height = BOARD_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = BOARD_BACKGROUND;
    ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    for (const item of session.ordered()) if (item.el) drawElement(ctx, item.el);
    canvas.toBlob((blob) => {
      if (blob) saveBlob(blob, `whiteboard-${new Date().toISOString().slice(0, 10)}.png`);
    }, 'image/png');
  }

  const count = session.ordered().filter((i) => i.el).length;

  return (
    <section
      aria-label="Whiteboard"
      className="flex w-full flex-col gap-2 rounded-2xl bg-surface-raised p-3 text-ink ring-1 ring-edge shadow-[0_4px_24px_rgba(0,0,0,0.25)]"
    >
      <div
        role="toolbar"
        aria-label="Whiteboard tools"
        className="flex flex-wrap items-center gap-1.5"
      >
        <div className="flex items-center gap-0.5 rounded-lg bg-surface-sunken p-0.5">
          {TOOLS.map((t) => (
            <ToolButton
              key={t.tool}
              label={`${t.label} (${t.key.toUpperCase()})`}
              pressed={tool === t.tool}
              onClick={() => setTool(t.tool)}
            >
              {t.icon}
            </ToolButton>
          ))}
        </div>

        <div role="radiogroup" aria-label="Colour" className="flex items-center gap-1 px-1">
          {BOARD_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={COLOR_NAMES[c]}
              title={COLOR_NAMES[c]}
              onClick={() => setColor(c)}
              className={`size-6 rounded-full border-2 transition-transform ${
                color === c ? 'scale-110 border-ink' : 'border-transparent'
              }`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        <div role="radiogroup" aria-label="Thickness" className="flex items-center gap-0.5">
          {WIDTHS.map((w, i) => (
            <button
              key={w.label}
              type="button"
              role="radio"
              aria-checked={widthIndex === i}
              aria-label={w.label}
              title={w.label}
              onClick={() => setWidthIndex(i)}
              className={`flex size-8 items-center justify-center rounded-md ${
                widthIndex === i ? 'bg-accent-soft' : 'hover:bg-surface-sunken'
              }`}
            >
              <span
                className="rounded-full bg-ink"
                style={{ width: 4 + i * 5, height: 4 + i * 5 }}
                aria-hidden="true"
              />
            </button>
          ))}
        </div>

        <div className="flex items-center gap-0.5">
          <ToolButton
            label="Undo (Ctrl+Z)"
            disabled={!session.canUndo}
            onClick={() => session.undo()}
          >
            <UndoIcon />
          </ToolButton>
          <ToolButton
            label="Redo (Ctrl+Shift+Z)"
            disabled={!session.canRedo}
            onClick={() => session.redo()}
          >
            <RedoIcon />
          </ToolButton>
          <ToolButton label="Save as image" disabled={!ready} onClick={exportPng}>
            <ExportIcon />
          </ToolButton>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {isHost &&
            (confirmClear ? (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    setConfirmClear(false);
                    void session.clear();
                  }}
                >
                  Clear for everyone
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={count === 0}
                onClick={() => setConfirmClear(true)}
              >
                Clear
              </Button>
            ))}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close whiteboard"
            className="rounded-md p-1.5 text-ink-muted hover:bg-surface-sunken hover:text-ink"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {presenterName && (
        <p className="text-xs text-ink-muted">
          {presenterName} is presenting.{' '}
          <button
            type="button"
            className="font-medium text-accent hover:underline"
            onClick={onShowPresentation}
          >
            Show the presentation
          </button>
        </p>
      )}
      {session.error && (
        <Alert tone="warning">
          {session.error}{' '}
          <button
            type="button"
            className="font-medium text-accent hover:underline"
            onClick={() => (session.loaded ? session.clearError() : session.retry())}
          >
            {session.loaded ? 'Dismiss' : 'Try again'}
          </button>
        </Alert>
      )}

      {/* As wide as fits, but never taller than the screen leaves room for:
          you cannot draw on the part of a board that is scrolled away. */}
      <div
        ref={frame}
        className="relative mx-auto overflow-hidden rounded-lg border border-edge"
        style={{
          aspectRatio: `${BOARD_WIDTH} / ${BOARD_HEIGHT}`,
          width: `max(18rem, min(100%, calc((100dvh - 15rem) * ${BOARD_WIDTH / BOARD_HEIGHT})))`,
        }}
      >
        <canvas
          ref={baseCanvas}
          role="img"
          aria-label={`Whiteboard with ${count} ${count === 1 ? 'item' : 'items'}`}
          className="absolute inset-0 size-full"
        />
        <canvas
          ref={liveCanvas}
          data-testid="board-canvas"
          aria-hidden="true"
          className={`absolute inset-0 size-full touch-none ${
            tool === 'text' ? 'cursor-text' : tool === 'eraser' ? 'cursor-cell' : 'cursor-crosshair'
          }`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishGesture}
          onPointerCancel={finishGesture}
          onPointerLeave={() => session.sendCursor(null)}
        />
        {text && (
          <TextBox
            x={text.x * scale}
            y={text.y * scale}
            size={width.text * scale}
            color={color}
            value={text.value}
            onChange={(value) => setText({ ...text, value })}
            onCommit={commitText}
            onCancel={() => setText(null)}
          />
        )}
        {!ready && !session.error && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/60 text-ink-muted">
            <Spinner label="Loading the whiteboard" />
          </div>
        )}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-ink-muted">
        End-to-end encrypted: the server stores this board but cannot see it.
      </p>
    </section>
  );
}

function ToolButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-8 items-center justify-center rounded-md transition-colors disabled:opacity-35 ${
        pressed ? 'bg-surface-raised text-accent shadow-sm' : 'text-ink-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

function TextBox({
  x,
  y,
  size,
  color,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  size: number;
  color: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onCommit();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }
  return (
    <textarea
      autoFocus
      aria-label="Text to add to the whiteboard"
      value={value}
      maxLength={500}
      rows={Math.max(1, value.split('\n').length)}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onCommit}
      className="absolute resize-none overflow-hidden border border-dashed border-accent bg-transparent p-0 leading-[1.25] outline-none"
      style={{
        left: x,
        top: y,
        fontSize: size,
        fontFamily: TEXT_FONT,
        color,
        minWidth: size * 4,
      }}
    />
  );
}
