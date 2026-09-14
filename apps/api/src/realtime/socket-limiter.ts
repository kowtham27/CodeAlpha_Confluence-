/**
 * Token bucket for one socket's event rate (spec: per-socket rate limits).
 * In memory, not Redis: a socket lives on exactly one instance, and these
 * checks run on every signaling message, where a network round trip per
 * ICE candidate would be waste.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(): boolean {
    const t = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((t - this.last) / 1000) * this.refillPerSecond,
    );
    this.last = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Signaling budget. A full mesh of 6 does 5 negotiations, each an offer, an
 * answer and a few dozen ICE candidates, plus ICE restarts; a burst of 300
 * refilling at 30/s covers that with room to spare while still stopping one
 * socket from flooding another through the relay.
 */
export const SIGNALING_BUDGET = { capacity: 300, refillPerSecond: 30 } as const;
