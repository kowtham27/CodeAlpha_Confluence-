import {
  ackSchema,
  boardAckSchema,
  boardCursorSchema,
  boardElementSchema,
  boardSnapshotSchema,
  type BoardCursor,
  type BoardElement,
  type BoardOp,
  type BoardStoredElement,
} from '@confluence/shared';
import { ApiError, request } from '../api';
import { loadE2E } from '../e2e';
import type { AppSocket } from '../realtime';

/**
 * One member's live view of a room's whiteboard: loads the snapshot, applies
 * changes in server order, sends this member's changes, and keeps the live
 * drafts and cursors of everyone else.
 *
 * A plain class rather than React state: drafts and cursors change dozens of
 * times a second and only the canvas needs them. React hears about committed
 * changes only (see subscribe).
 *
 * Every element, draft and cursor is encrypted with the room key, and each
 * ciphertext is bound (as associated data) to the room, the element or user
 * it belongs to, and its kind. The server can drop or reorder, but it cannot
 * read, forge, or swap them.
 */

export interface StoredElement {
  id: string;
  /** Null if it could not be decrypted or failed validation: shown as nothing. */
  el: BoardElement | null;
  seq: number;
  authorId: string;
}

interface LiveDraft {
  el: BoardElement;
  at: number;
}

interface LiveCursor extends BoardCursor {
  at: number;
}

type Action =
  | { kind: 'add'; id: string; el: BoardElement }
  | { kind: 'erase'; items: { id: string; el: BoardElement }[] };

const boardAck = ackSchema(boardAckSchema);
/** Live frames older than this are someone who stopped without saying so. */
export const LIVE_TTL_MS = 5_000;
/** Pending local elements sort above everything the server has ordered. */
const PENDING_BASE = 1e12;

const elementContext = (slug: string, id: string) => `confluence/board/v1/element/${slug}/${id}`;
const draftContext = (slug: string, id: string) => `confluence/board/v1/draft/${slug}/${id}`;
const cursorContext = (slug: string, userId: string) =>
  `confluence/board/v1/cursor/${slug}/${userId}`;

export class BoardSession {
  readonly elements = new Map<string, StoredElement>();
  /** peerId -> element id -> draft */
  readonly drafts = new Map<string, Map<string, LiveDraft>>();
  readonly cursors = new Map<string, LiveCursor>();
  loaded = false;
  error: string | null = null;
  /** Committed changes by other people since `markSeen`. */
  unseen = 0;

  private buffer: BoardOp[] | null = [];
  private lastClearSeq = 0;
  private pendingCounter = 0;
  private undoStack: Action[] = [];
  private redoStack: Action[] = [];
  private orderedCache: StoredElement[] | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly liveListeners = new Set<() => void>();
  private closed = false;
  private version = 0;

  constructor(
    private readonly socket: AppSocket,
    private readonly slug: string,
    private readonly roomKey: Uint8Array,
    private readonly selfUserId: string,
    /** Maps a sender's peer id to their user id, for cursor contexts. */
    private readonly userOfPeer: (peerId: string) => string | undefined,
  ) {
    socket.on('board:op', this.onOp);
    socket.on('board:draft', this.onDraft);
    socket.on('board:cursor', this.onCursor);
    void this.load();
  }

  close(): void {
    this.closed = true;
    this.socket.off('board:op', this.onOp);
    this.socket.off('board:draft', this.onDraft);
    this.socket.off('board:cursor', this.onCursor);
    this.listeners.clear();
    this.liveListeners.clear();
  }

  // ---- subscriptions ----------------------------------------------------------

  /** Committed changes, load state, errors, undo availability. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Drafts and cursors: for the canvas only. */
  subscribeLive(listener: () => void): () => void {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  /** Changes whenever subscribe() listeners fire; for useSyncExternalStore. */
  getVersion = (): number => this.version;

  private changed(): void {
    this.orderedCache = null;
    this.version += 1;
    for (const l of this.listeners) l();
  }

  private liveChanged(): void {
    for (const l of this.liveListeners) l();
  }

  /** Bottom to top. */
  ordered(): StoredElement[] {
    this.orderedCache ??= [...this.elements.values()].sort((a, b) => a.seq - b.seq);
    return this.orderedCache;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  markSeen(): void {
    if (this.unseen === 0) return;
    this.unseen = 0;
    this.changed();
  }

  // ---- crypto -------------------------------------------------------------------

  private async open(stored: BoardStoredElement): Promise<StoredElement> {
    let el: BoardElement | null = null;
    try {
      const e2e = await loadE2E();
      const text = await e2e.decryptText(
        stored.ciphertext,
        this.roomKey,
        elementContext(this.slug, stored.id),
      );
      el = boardElementSchema.parse(JSON.parse(text));
    } catch {
      el = null;
    }
    return { id: stored.id, el, seq: stored.seq, authorId: stored.authorId };
  }

  private async seal(el: BoardElement, context: string): Promise<string> {
    const e2e = await loadE2E();
    return e2e.encryptText(JSON.stringify(el), this.roomKey, context);
  }

  // ---- loading and applying server order ----------------------------------------

  /**
   * Incoming changes are applied strictly one after another. Decrypting is
   * async, so without this an add followed by its removal could land in the
   * wrong order and resurrect the element.
   */
  private queue: Promise<void> = Promise.resolve();
  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((error: unknown) => console.warn('board', error));
  }

  private async load(): Promise<void> {
    try {
      const snap = await request(`/rooms/${this.slug}/board`, {
        schema: boardSnapshotSchema,
        auth: true,
      });
      const opened = await Promise.all(snap.elements.map((e) => this.open(e)));
      this.enqueue(async () => {
        if (this.closed) return;
        this.elements.clear();
        for (const e of opened) this.elements.set(e.id, e);
        // Changes that arrived while loading. The snapshot already includes
        // those up to its seq; the rest apply on top, in order. Ops arriving
        // during this loop join the same buffer and are drained too.
        const pending = this.buffer ?? [];
        for (let op = pending.shift(); op; op = pending.shift()) {
          if (op.seq <= snap.seq) continue;
          this.applyOpened(op, op.kind === 'add' ? await this.open(op.element) : null);
        }
        this.buffer = null;
        this.loaded = true;
        this.error = null;
        this.changed();
        this.liveChanged();
      });
    } catch (error) {
      if (!this.closed) this.fail(error, 'Could not load the whiteboard.');
    }
  }

  /** After a failed load. */
  retry(): void {
    this.buffer = [];
    this.error = null;
    this.changed();
    void this.load();
  }

  private applyOpened(op: BoardOp, opened: StoredElement | null): void {
    if (op.kind === 'add' && opened) {
      const existing = this.elements.get(opened.id);
      if (!existing || existing.seq < opened.seq) this.elements.set(opened.id, opened);
      // Its draft, if we were watching it being drawn, is now the real thing.
      for (const drafts of this.drafts.values()) drafts.delete(opened.id);
    } else if (op.kind === 'remove') {
      for (const id of op.ids) this.elements.delete(id);
    } else if (op.kind === 'clear') {
      this.lastClearSeq = Math.max(this.lastClearSeq, op.seq);
      for (const [id, e] of this.elements) if (e.seq < op.seq) this.elements.delete(id);
      this.undoStack = [];
      this.redoStack = [];
    }
  }

  private onOp = (payload: { slug: string; op: BoardOp }): void => {
    if (payload.slug !== this.slug || this.closed) return;
    const { op } = payload;
    if (this.buffer) {
      this.buffer.push(op);
      return;
    }
    this.enqueue(async () => {
      const opened = op.kind === 'add' ? await this.open(op.element) : null;
      if (this.closed) return;
      this.applyOpened(op, opened);
      this.unseen += 1;
      this.changed();
      this.liveChanged();
    });
  };

  // ---- this member's changes ----------------------------------------------------

  private fail(error: unknown, fallback: string): void {
    this.error = error instanceof Error && error.message ? error.message : fallback;
    this.changed();
  }

  clearError(): void {
    this.error = null;
    this.changed();
  }

  /** Shows it at once, then confirms with the server. Returns the new id. */
  add(el: BoardElement, id: string = crypto.randomUUID(), record = true): string {
    this.pendingCounter += 1;
    this.elements.set(id, {
      id,
      el,
      seq: PENDING_BASE + this.pendingCounter,
      authorId: this.selfUserId,
    });
    if (record) {
      this.undoStack.push({ kind: 'add', id, el });
      this.redoStack = [];
    }
    this.changed();
    void this.commitAdd(id, el);
    return id;
  }

  private async commitAdd(id: string, el: BoardElement): Promise<void> {
    try {
      const ciphertext = await this.seal(el, elementContext(this.slug, id));
      const result = boardAck.parse(
        await this.socket
          .timeout(10_000)
          .emitWithAck('board:add', { slug: this.slug, id, ciphertext }),
      );
      if (!result.ok) throw new ApiError(0, result.error.code, result.error.message);
      const current = this.elements.get(id);
      // Cleared (on the server, after this add) while the ack was in flight.
      if (result.data.seq < this.lastClearSeq) this.elements.delete(id);
      else if (current) current.seq = result.data.seq;
      this.changed();
    } catch (error) {
      this.elements.delete(id);
      this.undoStack = this.undoStack.filter((a) => !(a.kind === 'add' && a.id === id));
      this.fail(error, 'That did not reach the board. Try again.');
    }
  }

  erase(ids: string[], record = true): void {
    const items = ids
      .map((id) => this.elements.get(id))
      .filter((e): e is StoredElement => e !== undefined);
    if (items.length === 0) return;
    for (const item of items) this.elements.delete(item.id);
    if (record) {
      const restorable = items.flatMap((i) => (i.el ? [{ id: i.id, el: i.el }] : []));
      if (restorable.length > 0) this.undoStack.push({ kind: 'erase', items: restorable });
      this.redoStack = [];
    }
    this.changed();
    void this.commitErase(items);
  }

  private async commitErase(items: StoredElement[]): Promise<void> {
    try {
      const result = boardAck.parse(
        await this.socket
          .timeout(10_000)
          .emitWithAck('board:remove', { slug: this.slug, ids: items.map((i) => i.id) }),
      );
      if (!result.ok) throw new ApiError(0, result.error.code, result.error.message);
    } catch (error) {
      for (const item of items) this.elements.set(item.id, item);
      this.fail(error, 'Could not erase that. Try again.');
    }
  }

  async clear(): Promise<void> {
    try {
      const result = boardAck.parse(
        await this.socket.timeout(10_000).emitWithAck('board:clear', { slug: this.slug }),
      );
      if (!result.ok) throw new ApiError(0, result.error.code, result.error.message);
      this.applyOpened({ kind: 'clear', seq: result.data.seq }, null);
      this.changed();
    } catch (error) {
      this.fail(error, 'Could not clear the board.');
    }
  }

  undo(): void {
    const action = this.undoStack.pop();
    if (!action) return;
    if (action.kind === 'add') this.erase([action.id], false);
    else for (const item of action.items) this.add(item.el, item.id, false);
    this.redoStack.push(action);
    this.changed();
  }

  redo(): void {
    const action = this.redoStack.pop();
    if (!action) return;
    if (action.kind === 'add') this.add(action.el, action.id, false);
    else
      this.erase(
        action.items.map((i) => i.id),
        false,
      );
    this.undoStack.push(action);
    this.changed();
  }

  // ---- live frames ----------------------------------------------------------------

  /** `el: null` ends the draft. Callers throttle. */
  sendDraft(id: string, el: BoardElement | null): void {
    if (!el) {
      this.socket.emit('board:draft', { slug: this.slug, id, ciphertext: null });
      return;
    }
    void this.seal(el, draftContext(this.slug, id)).then((ciphertext) => {
      // Too big to relay live (a very long stroke): the commit still shows it.
      if (ciphertext.length > 24_000) return;
      this.socket.emit('board:draft', { slug: this.slug, id, ciphertext });
    });
  }

  sendCursor(point: BoardCursor | null): void {
    if (!point) {
      this.socket.emit('board:cursor', { slug: this.slug, ciphertext: null });
      return;
    }
    void loadE2E()
      .then((e2e) =>
        e2e.encryptText(
          JSON.stringify(point),
          this.roomKey,
          cursorContext(this.slug, this.selfUserId),
        ),
      )
      .then((ciphertext) => this.socket.emit('board:cursor', { slug: this.slug, ciphertext }));
  }

  private onDraft = (p: { slug: string; from: string; id: string; ciphertext: string | null }) => {
    if (p.slug !== this.slug || this.closed) return;
    const mine = this.drafts.get(p.from) ?? new Map<string, LiveDraft>();
    this.drafts.set(p.from, mine);
    if (p.ciphertext === null) {
      mine.delete(p.id);
      this.liveChanged();
      return;
    }
    void loadE2E()
      .then((e2e) =>
        e2e.decryptText(p.ciphertext ?? '', this.roomKey, draftContext(this.slug, p.id)),
      )
      .then((text) => {
        // A draft of something already committed is stale.
        if (this.elements.has(p.id)) return;
        mine.set(p.id, { el: boardElementSchema.parse(JSON.parse(text)), at: Date.now() });
        this.liveChanged();
      })
      .catch(() => undefined);
  };

  private onCursor = (p: { slug: string; from: string; ciphertext: string | null }) => {
    if (p.slug !== this.slug || this.closed) return;
    if (p.ciphertext === null) {
      this.cursors.delete(p.from);
      this.liveChanged();
      return;
    }
    const userId = this.userOfPeer(p.from);
    if (!userId) return;
    void loadE2E()
      .then((e2e) =>
        e2e.decryptText(p.ciphertext ?? '', this.roomKey, cursorContext(this.slug, userId)),
      )
      .then((text) => {
        this.cursors.set(p.from, { ...boardCursorSchema.parse(JSON.parse(text)), at: Date.now() });
        this.liveChanged();
      })
      .catch(() => undefined);
  };

  /** Drops the drafts and cursors of someone who left or went quiet. */
  pruneLive(present: ReadonlySet<string>): void {
    const now = Date.now();
    let changed = false;
    for (const [peer, drafts] of this.drafts) {
      for (const [id, d] of drafts) {
        if (!present.has(peer) || now - d.at > LIVE_TTL_MS) {
          drafts.delete(id);
          changed = true;
        }
      }
    }
    for (const [peer, c] of this.cursors) {
      if (!present.has(peer) || now - c.at > LIVE_TTL_MS) {
        this.cursors.delete(peer);
        changed = true;
      }
    }
    if (changed) this.liveChanged();
  }
}
