import type { BoardElement } from '@confluence/shared';

/**
 * Pure geometry for the whiteboard, in board units (see BOARD_WIDTH).
 * Kept free of canvas and React so it is cheap to unit-test.
 */

/**
 * Ramer–Douglas–Peucker on a flat [x0, y0, x1, y1, ...] list. A freehand
 * stroke arrives as hundreds of pointer samples; most sit on a straight
 * enough line to drop, which keeps elements small on the wire.
 */
export function simplify(points: readonly number[], epsilon = 1.2): number[] {
  const n = points.length / 2;
  if (n <= 2) return [...points];
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let worst = -1;
    let worstDist = epsilon;
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(
        points[i * 2] ?? 0,
        points[i * 2 + 1] ?? 0,
        points[first * 2] ?? 0,
        points[first * 2 + 1] ?? 0,
        points[last * 2] ?? 0,
        points[last * 2 + 1] ?? 0,
      );
      if (d > worstDist) {
        worst = i;
        worstDist = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(points[i * 2] ?? 0, points[i * 2 + 1] ?? 0);
  }
  return out;
}

export function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Points around an ellipse's outline, for hit-testing it like a polygon. */
function ellipseOutline(x1: number, y1: number, x2: number, y2: number, steps = 48): number[] {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;
  const out: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    out.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a));
  }
  return out;
}

function nearPolyline(points: readonly number[], x: number, y: number, radius: number): boolean {
  if (points.length === 2) return Math.hypot(x - (points[0] ?? 0), y - (points[1] ?? 0)) <= radius;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const d = distToSegment(
      x,
      y,
      points[i] ?? 0,
      points[i + 1] ?? 0,
      points[i + 2] ?? 0,
      points[i + 3] ?? 0,
    );
    if (d <= radius) return true;
  }
  return false;
}

/** Rough text box: good enough to erase text by touching it. */
export function textBox(el: Extract<BoardElement, { type: 'text' }>) {
  const lines = el.text.split('\n');
  const widest = Math.max(...lines.map((l) => l.length));
  return { x: el.x, y: el.y, w: widest * el.size * 0.6, h: lines.length * el.size * 1.25 };
}

/** Does a touch at (x, y) with this radius land on the element's ink? */
export function hitTest(el: BoardElement, x: number, y: number, radius: number): boolean {
  switch (el.type) {
    case 'stroke':
      return nearPolyline(el.points, x, y, radius + el.width / 2);
    case 'line':
    case 'arrow':
      return distToSegment(x, y, el.x1, el.y1, el.x2, el.y2) <= radius + el.width / 2;
    case 'rect': {
      const outline = [el.x1, el.y1, el.x2, el.y1, el.x2, el.y2, el.x1, el.y2, el.x1, el.y1];
      return nearPolyline(outline, x, y, radius + el.width / 2);
    }
    case 'ellipse':
      return nearPolyline(ellipseOutline(el.x1, el.y1, el.x2, el.y2), x, y, radius + el.width / 2);
    case 'text': {
      const box = textBox(el);
      return (
        x >= box.x - radius &&
        x <= box.x + box.w + radius &&
        y >= box.y - radius &&
        y <= box.y + box.h + radius
      );
    }
  }
}
