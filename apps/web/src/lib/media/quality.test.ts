import { describe, expect, it } from 'vitest';
import { grade } from './quality';

describe('grade', () => {
  it('calls a clean, close connection good', () => {
    expect(grade({ rtt: 0.04, loss: 0, jitter: 0.005 })).toBe('good');
  });

  it('is fair once delay or loss is noticeable', () => {
    expect(grade({ rtt: 0.3, loss: 0, jitter: 0 })).toBe('fair');
    expect(grade({ rtt: 0.05, loss: 0.03, jitter: 0 })).toBe('fair');
    expect(grade({ rtt: 0.05, loss: 0, jitter: 0.08 })).toBe('fair');
  });

  it('is poor when audio would break up', () => {
    expect(grade({ rtt: 0.8, loss: 0, jitter: 0 })).toBe('poor');
    expect(grade({ rtt: 0.05, loss: 0.2, jitter: 0 })).toBe('poor');
  });

  it('assumes the best while measurements are missing (first sample)', () => {
    expect(grade({ rtt: null, loss: null, jitter: null })).toBe('good');
  });
});
