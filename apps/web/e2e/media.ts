import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import { AUTH, createVerifiedAccount, signIn, uniqueEmail } from './support';

/**
 * Test-side instrumentation: every RTCPeerConnection the app creates is
 * recorded on window.__pcs, so tests can read genuine WebRTC stats. The app
 * itself ships no test hooks.
 */
const RECORD_PEER_CONNECTIONS = `
  (() => {
    const Original = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = class extends Original {
      constructor(...args) { super(...args); window.__pcs.push(this); }
    };
  })();
`;

/**
 * Headless Chromium has no screen to pick, and a test must also be able to
 * press the browser's own "Stop sharing" button. So getDisplayMedia returns
 * an animated 1280x720 canvas (wider than the 640px cameras, which makes the
 * swap visible in the receiver's stats) plus a generated tone (so the mic +
 * screen-audio mixer is exercised). window.__endScreenShare() ends the track
 * the way the browser does: the source stops and 'ended' fires.
 */
const FAKE_SCREEN = `
  (() => {
    if (!navigator.mediaDevices) return;
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 720;
      const g = canvas.getContext('2d');
      let n = 0;
      const draw = () => {
        n += 1;
        g.fillStyle = 'hsl(' + (n % 360) + ' 60% 45%)';
        g.fillRect(0, 0, 1280, 720);
        g.fillStyle = '#fff';
        g.font = '72px sans-serif';
        g.fillText('SHARED SCREEN ' + n, 80, 380);
      };
      draw();
      const timer = setInterval(draw, 66);
      const stream = canvas.captureStream(15);
      const audio = new AudioContext();
      const tone = audio.createOscillator();
      const out = audio.createMediaStreamDestination();
      tone.connect(out);
      tone.start();
      stream.addTrack(out.stream.getAudioTracks()[0]);
      const video = stream.getVideoTracks()[0];
      window.__endScreenShare = () => {
        clearInterval(timer);
        tone.stop();
        for (const t of stream.getTracks()) t.stop();
        video.dispatchEvent(new Event('ended'));
      };
      return stream;
    };
  })();
`;

export interface PeerStats {
  audioBytes: number;
  videoFrames: number;
  /** Width of the video currently being received on this connection. */
  frameWidth: number;
}

/** Inbound media per connected peer connection on this page. */
export function inboundStats(page: Page): Promise<PeerStats[]> {
  return page.evaluate(async () => {
    const all = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const results: { audioBytes: number; videoFrames: number; frameWidth: number }[] = [];
    for (const pc of all.filter((p) => p.connectionState === 'connected')) {
      const report = await pc.getStats();
      const row = { audioBytes: 0, videoFrames: 0, frameWidth: 0 };
      report.forEach(
        (r: {
          type: string;
          kind?: string;
          bytesReceived?: number;
          framesDecoded?: number;
          frameWidth?: number;
        }) => {
          if (r.type !== 'inbound-rtp') return;
          if (r.kind === 'audio') row.audioBytes += r.bytesReceived ?? 0;
          if (r.kind === 'video') {
            row.videoFrames += r.framesDecoded ?? 0;
            row.frameWidth = Math.max(row.frameWidth, r.frameWidth ?? 0);
          }
        },
      );
      results.push(row);
    }
    return results;
  });
}

/** Widest video this page is receiving from anyone. */
export async function widestInbound(page: Page): Promise<number> {
  return Math.max(0, ...(await inboundStats(page)).map((s) => s.frameWidth));
}

export interface Person {
  context: BrowserContext;
  page: Page;
}

/** A signed-in person with fake camera, mic, and screen, on their home page. */
export async function person(
  browser: Browser,
  request: APIRequestContext,
  name: string,
): Promise<Person> {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await context.addInitScript(RECORD_PEER_CONNECTIONS);
  await context.addInitScript(FAKE_SCREEN);
  const page = await context.newPage();
  const email = uniqueEmail(name.toLowerCase());
  await createVerifiedAccount(page, request, name, email);
  await signIn(page, email);
  await expect(page.getByRole('heading', { name: `Hi, ${name}` })).toBeVisible(AUTH);
  return { context, page };
}

export const tiles = (page: Page) =>
  page.getByRole('list', { name: 'Participants' }).getByRole('listitem');

/** Waits until this page has `count` connected peer connections. */
export async function expectConnected(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await inboundStats(page)).length, { timeout: 30_000 }).toBe(count);
}
