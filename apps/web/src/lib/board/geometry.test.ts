import { describe, expect, it } from 'vitest';
import type { BoardElement } from '@confluence/shared';
import { distToSegment, hitTest, simplify } from './geometry';

describe('simplify', () => {
  it('drops points that lie on a straight line, keeping the ends', () => {
    const line = [0, 0, 10, 0, 20, 0, 30, 0, 40, 0];
    expect(simplify(line)).toEqual([0, 0, 40, 0]);
  });

  it('keeps the corners of a shape', () => {
    const corner = [0, 0, 50, 0, 100, 0, 100, 50, 100, 100];
    expect(simplify(corner)).toEqual([0, 0, 100, 0, 100, 100]);
  });

  it('shrinks a wobbly freehand stroke without moving it by more than epsilon', () => {
    const samples: number[] = [];
    for (let x = 0; x <= 500; x++) samples.push(x, Math.round(Math.sin(x / 40) * 60));
    const simple = simplify(samples, 1.2);
    expect(simple.length).toBeLessThan(samples.length / 5);
    expect(simple.slice(0, 2)).toEqual([0, 0]);
  });

  it('leaves single points and pairs alone', () => {
    expect(simplify([5, 5])).toEqual([5, 5]);
    expect(simplify([0, 0, 9, 9])).toEqual([0, 0, 9, 9]);
  });
});

describe('distToSegment', () => {
  it('measures to the nearest point of the segment, not the infinite line', () => {
    expect(distToSegment(5, 3, 0, 0, 10, 0)).toBe(3);
    expect(distToSegment(13, 4, 0, 0, 10, 0)).toBe(5);
    expect(distToSegment(2, 2, 1, 1, 1, 1)).toBeCloseTo(Math.SQRT2);
  });
});

describe('hitTest', () => {
  const black = '#1f2937' as const;

  it('hits a stroke on its ink, allowing for its width', () => {
    const stroke: BoardElement = {
      type: 'stroke',
      color: black,
      width: 10,
      points: [0, 0, 100, 0],
    };
    expect(hitTest(stroke, 50, 12, 8)).toBe(true);
    expect(hitTest(stroke, 50, 30, 8)).toBe(false);
  });

  it('hits a rectangle on its outline only, so you can erase what is inside it', () => {
    const rect: BoardElement = {
      type: 'rect',
      color: black,
      width: 2,
      x1: 0,
      y1: 0,
      x2: 200,
      y2: 100,
    };
    expect(hitTest(rect, 100, 1, 4)).toBe(true);
    expect(hitTest(rect, 100, 50, 4)).toBe(false);
  });

  it('hits an ellipse near its curve', () => {
    const ellipse: BoardElement = {
      type: 'ellipse',
      color: black,
      width: 2,
      x1: 0,
      y1: 0,
      x2: 200,
      y2: 100,
    };
    expect(hitTest(ellipse, 200, 50, 4)).toBe(true);
    expect(hitTest(ellipse, 100, 50, 4)).toBe(false);
  });

  it('hits text anywhere in its box', () => {
    const text: BoardElement = {
      type: 'text',
      color: black,
      size: 20,
      x: 10,
      y: 10,
      text: 'Hello',
    };
    expect(hitTest(text, 30, 20, 2)).toBe(true);
    expect(hitTest(text, 300, 20, 2)).toBe(false);
  });
});
