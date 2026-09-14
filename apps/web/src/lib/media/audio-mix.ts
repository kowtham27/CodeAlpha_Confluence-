/**
 * Mixes the microphone with a shared screen's audio into one track.
 *
 * Every connection has exactly one audio transceiver (see MeshTransport), so
 * "share the video with its sound" cannot add a second audio track without a
 * renegotiation. Instead, while presenting, the audio sender carries this mix.
 * Muting still works: a disabled microphone track renders silence into the
 * mix, and the screen audio carries on.
 */
export class AudioMixer {
  private readonly context = new AudioContext();
  private readonly destination = this.context.createMediaStreamDestination();
  private readonly screen: MediaStreamAudioSourceNode;
  private mic: MediaStreamAudioSourceNode | null = null;

  constructor(mic: MediaStreamTrack | null, screen: MediaStreamTrack) {
    this.screen = this.context.createMediaStreamSource(new MediaStream([screen]));
    this.screen.connect(this.destination);
    this.setMic(mic);
  }

  /** The mixed track to publish. */
  get track(): MediaStreamTrack | null {
    return this.destination.stream.getAudioTracks()[0] ?? null;
  }

  /** Swap the microphone feeding the mix (device switch mid-presentation). */
  setMic(track: MediaStreamTrack | null): void {
    this.mic?.disconnect();
    this.mic = track ? this.context.createMediaStreamSource(new MediaStream([track])) : null;
    this.mic?.connect(this.destination);
  }

  close(): void {
    this.mic?.disconnect();
    this.screen.disconnect();
    void this.context.close();
  }
}
