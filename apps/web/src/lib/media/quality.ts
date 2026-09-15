/**
 * Connection quality per peer (spec Phase 8), from WebRTC statistics:
 * round-trip time of the connection in use, packet loss over the last
 * interval, and audio jitter. Thresholds follow common VoIP guidance: past
 * ~250 ms round trip or ~2% loss people start talking over each other; past
 * ~500 ms or ~8% loss, audio breaks up.
 */

export type ConnectionQuality = 'good' | 'fair' | 'poor';

export interface Sample {
  /** Seconds. */
  rtt: number | null;
  /** 0..1 over the last interval. */
  loss: number | null;
  /** Seconds. */
  jitter: number | null;
}

export function grade({ rtt, loss, jitter }: Sample): ConnectionQuality {
  if ((rtt ?? 0) > 0.5 || (loss ?? 0) > 0.08) return 'poor';
  if ((rtt ?? 0) > 0.25 || (loss ?? 0) > 0.02 || (jitter ?? 0) > 0.05) return 'fair';
  return 'good';
}

interface Counters {
  received: number;
  lost: number;
}

interface StatsEntry {
  id?: string;
  type: string;
  kind?: string;
  state?: string;
  nominated?: boolean;
  selectedCandidatePairId?: string;
  currentRoundTripTime?: number;
  packetsReceived?: number;
  packetsLost?: number;
  jitter?: number;
}

/** Turns cumulative counters into per-interval loss, one peer at a time. */
export class QualityMonitor {
  private readonly last = new Map<RTCPeerConnection, Counters>();

  async measure(pc: RTCPeerConnection): Promise<ConnectionQuality> {
    const report = await pc.getStats();
    const entries: StatsEntry[] = [];
    report.forEach((r: StatsEntry) => entries.push(r));

    // The pair actually carrying traffic: the transport names it; older
    // browsers mark it nominated and succeeded instead.
    const selectedId = entries.find((e) => e.type === 'transport')?.selectedCandidatePairId;
    const pair =
      entries.find(
        (e) => e.type === 'candidate-pair' && selectedId !== undefined && e.id === selectedId,
      ) ??
      entries.find((e) => e.type === 'candidate-pair' && e.nominated && e.state === 'succeeded');

    let received = 0;
    let lost = 0;
    let jitter: number | null = null;
    for (const e of entries) {
      if (e.type !== 'inbound-rtp') continue;
      received += e.packetsReceived ?? 0;
      lost += Math.max(0, e.packetsLost ?? 0);
      if (e.kind === 'audio' && e.jitter !== undefined) jitter = e.jitter;
    }

    const before = this.last.get(pc);
    this.last.set(pc, { received, lost });
    let loss: number | null = null;
    if (before) {
      const dReceived = received - before.received;
      const dLost = lost - before.lost;
      if (dReceived + dLost > 0) loss = Math.max(0, dLost) / (dReceived + dLost);
    }

    return grade({ rtt: pair?.currentRoundTripTime ?? null, loss, jitter });
  }

  forget(pc: RTCPeerConnection): void {
    this.last.delete(pc);
  }
}
