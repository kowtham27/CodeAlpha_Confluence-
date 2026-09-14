/**
 * Active-speaker detection (spec: AudioContext + AnalyserNode RMS on each
 * stream). One shared AudioContext; one analyser per participant.
 *
 * The raw loudest-stream-wins signal flickers between people on every
 * breath, so it is smoothed and held: someone becomes the active speaker
 * after sustained level above the threshold, and stays it for a moment
 * after they stop.
 */

const SAMPLE_MS = 100;
/** RMS of float samples in [-1, 1]; ordinary speech sits around 0.02-0.2. */
const THRESHOLD = 0.02;
const HOLD_MS = 900;
const SMOOTHING = 0.6;

interface Entry {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  buffer: Float32Array<ArrayBuffer>;
  level: number;
}

export class SpeakingDetector {
  private readonly context: AudioContext | null;
  private readonly entries = new Map<string, Entry>();
  private readonly timer: ReturnType<typeof setInterval>;
  private active: string | null = null;
  private activeSince = 0;

  constructor(private readonly onChange: (activeId: string | null) => void) {
    this.context = typeof AudioContext === 'undefined' ? null : new AudioContext();
    this.timer = setInterval(() => this.sample(), SAMPLE_MS);
  }

  /**
   * An AudioContext created without a user gesture starts suspended. Call on
   * any click; harmless once running.
   */
  resume(): void {
    if (this.context?.state === 'suspended') void this.context.resume();
  }

  track(id: string, stream: MediaStream | null): void {
    const existing = this.entries.get(id);
    const audio = stream?.getAudioTracks()[0];
    if (existing && audio && existing.source.mediaStream === stream) return;
    this.untrack(id);
    if (!this.context || !stream || !audio) return;

    const source = this.context.createMediaStreamSource(stream);
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 512;
    // Analysed only, never connected to the speakers: playback is the
    // <video> element's job, and routing here too would double the audio.
    source.connect(analyser);
    this.entries.set(id, {
      source,
      analyser,
      buffer: new Float32Array(analyser.fftSize),
      level: 0,
    });
  }

  untrack(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.source.disconnect();
    this.entries.delete(id);
  }

  close(): void {
    clearInterval(this.timer);
    for (const id of [...this.entries.keys()]) this.untrack(id);
    void this.context?.close();
  }

  private sample(): void {
    let loudest: string | null = null;
    let loudestLevel = THRESHOLD;
    for (const [id, entry] of this.entries) {
      entry.analyser.getFloatTimeDomainData(entry.buffer);
      let sum = 0;
      for (const v of entry.buffer) sum += v * v;
      const rms = Math.sqrt(sum / entry.buffer.length);
      entry.level = entry.level * SMOOTHING + rms * (1 - SMOOTHING);
      if (entry.level > loudestLevel) {
        loudest = id;
        loudestLevel = entry.level;
      }
    }

    const now = Date.now();
    if (loudest && loudest !== this.active) {
      this.setActive(loudest, now);
    } else if (loudest) {
      this.activeSince = now;
    } else if (this.active && now - this.activeSince > HOLD_MS) {
      this.setActive(null, now);
    }
  }

  private setActive(id: string | null, now: number): void {
    this.active = id;
    this.activeSince = now;
    this.onChange(id);
  }
}
