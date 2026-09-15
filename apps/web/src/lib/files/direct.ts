import { z } from 'zod';
import { MAX_FILE_BYTES, sniffFile } from './sniff';

/**
 * Direct, in-call file transfers over each peer connection's 'files' data
 * channel (spec Phase 5a). Nothing touches the server: bytes go browser to
 * browser, encrypted in transit by the connection's DTLS. Nothing is kept,
 * either: a transfer exists only in the memory of the two tabs.
 *
 * Wire protocol, per channel, ordered: a JSON `begin`, the file's bytes as
 * binary messages of CHUNK_BYTES, then a JSON `end`. Either side may send
 * `cancel`. One transfer per direction at a time per peer; more are queued.
 */

const CHUNK_BYTES = 16 * 1024;
/** Read the file in large blocks; send it in small messages. */
const READ_BYTES = 1024 * 1024;
/** Pause sending above this much queued data, resume below LOW. */
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
/** Progress is published at most this often; 6,400 re-renders per 100 MB would be silly. */
const PROGRESS_MS = 100;

const controlSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('begin'),
    id: z.uuid(),
    name: z.string().min(1).max(255),
    type: z.string().max(127),
    size: z.number().int().positive().max(MAX_FILE_BYTES),
  }),
  z.object({ t: z.literal('end'), id: z.uuid() }),
  z.object({ t: z.literal('cancel'), id: z.uuid() }),
]);
type Control = z.infer<typeof controlSchema>;

export type TransferStatus = 'queued' | 'active' | 'complete' | 'failed' | 'cancelled';

export interface DirectTransfer {
  /** Unique locally: direction, peer and wire id. */
  key: string;
  id: string;
  peerId: string;
  direction: 'in' | 'out';
  name: string;
  type: string;
  size: number;
  transferred: number;
  status: TransferStatus;
  error: string | null;
  /** The received file, once complete and checked. */
  blob: Blob | null;
  startedAt: number;
}

interface Incoming {
  key: string;
  parts: ArrayBuffer[];
  received: number;
}

export class DirectTransfers {
  private readonly channels = new Map<string, RTCDataChannel>();
  private readonly transfers = new Map<string, DirectTransfer>();
  private readonly incoming = new Map<string, Incoming>();
  private readonly sendQueues = new Map<string, Promise<void>>();
  private readonly outgoingFiles = new Map<string, Blob>();
  private readonly listeners = new Set<() => void>();
  private snapshot: { transfers: DirectTransfer[]; openPeers: string[] } = {
    transfers: [],
    openPeers: [],
  };
  private progressTimer: ReturnType<typeof setTimeout> | undefined;

  // ---- subscription, for useSyncExternalStore ---------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): { transfers: DirectTransfer[]; openPeers: string[] } => this.snapshot;

  private publish(): void {
    clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.snapshot = {
      transfers: [...this.transfers.values()].sort((a, b) => b.startedAt - a.startedAt),
      openPeers: [...this.channels].filter(([, c]) => c.readyState === 'open').map(([id]) => id),
    };
    for (const listener of this.listeners) listener();
  }

  /** Coalesces progress updates into one publish per PROGRESS_MS. */
  private publishSoon(): void {
    this.progressTimer ??= setTimeout(() => this.publish(), PROGRESS_MS);
  }

  private update(key: string, patch: Partial<DirectTransfer>, soon = false): void {
    const current = this.transfers.get(key);
    if (!current) return;
    this.transfers.set(key, { ...current, ...patch });
    if (soon) this.publishSoon();
    else this.publish();
  }

  // ---- channels ---------------------------------------------------------------

  attach(peerId: string, channel: RTCDataChannel): void {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = LOW_WATER;
    this.channels.set(peerId, channel);

    channel.onopen = () => this.publish();
    channel.onmessage = (e: MessageEvent<unknown>) => this.onMessage(peerId, e.data);
    channel.onclose = () => {
      // A rebuild replaces the channel; only the current one speaks for the peer.
      if (this.channels.get(peerId) !== channel) return;
      this.channels.delete(peerId);
      this.failPeer(peerId, 'The connection to this person was lost.');
    };
    this.publish();
  }

  private failPeer(peerId: string, error: string): void {
    for (const t of this.transfers.values()) {
      if (t.peerId === peerId && (t.status === 'active' || t.status === 'queued')) {
        this.transfers.set(t.key, { ...t, status: 'failed', error });
      }
    }
    this.incoming.delete(peerId);
    this.publish();
  }

  // ---- sending ------------------------------------------------------------------

  /** Queues `file` to every peer in `peerIds`. `type` is the sniffed type. */
  send(peerIds: readonly string[], file: File, type: string): void {
    for (const peerId of peerIds) {
      const id = crypto.randomUUID();
      const key = `out:${peerId}:${id}`;
      this.transfers.set(key, {
        key,
        id,
        peerId,
        direction: 'out',
        name: file.name,
        type,
        size: file.size,
        transferred: 0,
        status: 'queued',
        error: null,
        blob: null,
        startedAt: Date.now(),
      });
      this.outgoingFiles.set(key, file);
      const previous = this.sendQueues.get(peerId) ?? Promise.resolve();
      this.sendQueues.set(
        peerId,
        previous.then(() => this.pump(key)).catch((error: unknown) => console.warn(error)),
      );
    }
    this.publish();
  }

  private async pump(key: string): Promise<void> {
    const file = this.outgoingFiles.get(key);
    const start = this.transfers.get(key);
    if (!file || !start || start.status !== 'queued') return;
    const channel = this.channels.get(start.peerId);
    try {
      if (channel?.readyState !== 'open') throw new Error('This person is not connected.');
      this.update(key, { status: 'active' });
      this.sendControl(channel, {
        t: 'begin',
        id: start.id,
        name: start.name,
        type: start.type,
        size: start.size,
      });

      let offset = 0;
      while (offset < file.size) {
        const block = await file.slice(offset, offset + READ_BYTES).arrayBuffer();
        for (let at = 0; at < block.byteLength; at += CHUNK_BYTES) {
          if (this.transfers.get(key)?.status !== 'active') return; // cancelled
          if (channel.readyState !== 'open') throw new Error('The connection was lost.');
          if (channel.bufferedAmount > HIGH_WATER) await drained(channel);
          channel.send(block.slice(at, at + CHUNK_BYTES));
        }
        offset += block.byteLength;
        this.update(key, { transferred: offset }, true);
      }
      this.sendControl(channel, { t: 'end', id: start.id });
      // Sent means handed to the browser, not delivered: wait for the queue
      // to empty before calling it done.
      while (channel.bufferedAmount > 0 && channel.readyState === 'open') {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (channel.readyState !== 'open') throw new Error('The connection was lost.');
      this.update(key, { status: 'complete', transferred: file.size });
    } catch (error) {
      if (
        this.transfers.get(key)?.status === 'active' ||
        this.transfers.get(key)?.status === 'queued'
      ) {
        this.update(key, {
          status: 'failed',
          error: error instanceof Error ? error.message : 'The transfer failed.',
        });
      }
    } finally {
      this.outgoingFiles.delete(key);
    }
  }

  private sendControl(channel: RTCDataChannel, message: Control): void {
    channel.send(JSON.stringify(message));
  }

  cancel(key: string): void {
    const t = this.transfers.get(key);
    if (!t || (t.status !== 'active' && t.status !== 'queued')) return;
    const channel = this.channels.get(t.peerId);
    if (channel?.readyState === 'open' && t.status === 'active') {
      this.sendControl(channel, { t: 'cancel', id: t.id });
    }
    if (t.direction === 'in') this.incoming.delete(t.peerId);
    this.update(key, { status: 'cancelled' });
  }

  /** Removes finished transfers from the list, releasing received files. */
  dismiss(key: string): void {
    const t = this.transfers.get(key);
    if (!t || t.status === 'active' || t.status === 'queued') return;
    this.transfers.delete(key);
    this.publish();
  }

  // ---- receiving ----------------------------------------------------------------

  private onMessage(peerId: string, data: unknown): void {
    if (data instanceof ArrayBuffer) {
      this.onChunk(peerId, data);
      return;
    }
    if (typeof data !== 'string' || data.length > 2048) return;
    let parsed: Control;
    try {
      parsed = controlSchema.parse(JSON.parse(data));
    } catch {
      return; // not ours, or malformed: ignore rather than trust
    }
    if (parsed.t === 'begin') this.onBegin(peerId, parsed);
    else if (parsed.t === 'end') void this.onEnd(peerId, parsed.id);
    else this.onCancel(peerId, parsed.id);
  }

  private onBegin(peerId: string, begin: Extract<Control, { t: 'begin' }>): void {
    const previous = this.incoming.get(peerId);
    if (previous) this.update(previous.key, { status: 'failed', error: 'Interrupted.' });
    const key = `in:${peerId}:${begin.id}`;
    this.transfers.set(key, {
      key,
      id: begin.id,
      peerId,
      direction: 'in',
      name: begin.name,
      type: begin.type,
      size: begin.size,
      transferred: 0,
      status: 'active',
      error: null,
      blob: null,
      startedAt: Date.now(),
    });
    this.incoming.set(peerId, { key, parts: [], received: 0 });
    this.publish();
  }

  private onChunk(peerId: string, chunk: ArrayBuffer): void {
    const current = this.incoming.get(peerId);
    if (!current) return;
    const t = this.transfers.get(current.key);
    if (!t) return;
    current.received += chunk.byteLength;
    // A sender that sends more than it announced is misbehaving: stop there.
    if (current.received > t.size) {
      this.incoming.delete(peerId);
      const channel = this.channels.get(peerId);
      if (channel?.readyState === 'open') this.sendControl(channel, { t: 'cancel', id: t.id });
      this.update(t.key, { status: 'failed', error: 'The file was larger than announced.' });
      return;
    }
    current.parts.push(chunk);
    this.update(t.key, { transferred: current.received }, true);
  }

  private async onEnd(peerId: string, id: string): Promise<void> {
    const current = this.incoming.get(peerId);
    const t = current && this.transfers.get(current.key);
    if (!current || !t || t.id !== id) return;
    this.incoming.delete(peerId);
    if (current.received !== t.size) {
      this.update(t.key, { status: 'failed', error: 'The file arrived incomplete.' });
      return;
    }
    const blob = new Blob(current.parts, { type: t.type });
    // Check what actually arrived, not what the sender said it was.
    const verdict = await sniffFile(blob, t.name);
    if (!verdict.ok) {
      this.update(t.key, { status: 'failed', error: verdict.reason });
      return;
    }
    const typed = verdict.type === t.type ? blob : new Blob([blob], { type: verdict.type });
    this.update(t.key, {
      status: 'complete',
      transferred: t.size,
      blob: typed,
      type: verdict.type,
    });
  }

  private onCancel(peerId: string, id: string): void {
    for (const direction of ['in', 'out'] as const) {
      const key = `${direction}:${peerId}:${id}`;
      const t = this.transfers.get(key);
      if (t && (t.status === 'active' || t.status === 'queued')) {
        if (direction === 'in') this.incoming.delete(peerId);
        this.update(key, {
          status: 'cancelled',
          error: direction === 'out' ? 'They declined the file.' : 'The sender cancelled.',
        });
      }
    }
  }

  close(): void {
    clearTimeout(this.progressTimer);
    for (const t of this.transfers.values()) {
      if (t.status === 'active' || t.status === 'queued') this.cancel(t.key);
    }
    this.channels.clear();
    this.listeners.clear();
  }
}

function drained(channel: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      channel.removeEventListener('bufferedamountlow', done);
      channel.removeEventListener('close', done);
      resolve();
    };
    channel.addEventListener('bufferedamountlow', done);
    channel.addEventListener('close', done);
  });
}
