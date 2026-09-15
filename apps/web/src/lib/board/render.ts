import type { BoardElement } from '@confluence/shared';

/**
 * Draws elements onto a 2D context already scaled to board units. Used for
 * the live canvas and for the PNG export, so both look the same.
 */

export const BOARD_BACKGROUND = '#ffffff';

/** Line, arrow, rectangle and ellipse share one shape: two corner points. */
type ShapeElement = Extract<BoardElement, { x1: number }>;
export const TEXT_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

function arrowHead(ctx: CanvasRenderingContext2D, el: ShapeElement) {
  const angle = Math.atan2(el.y2 - el.y1, el.x2 - el.x1);
  const size = 10 + el.width * 2;
  ctx.beginPath();
  ctx.moveTo(el.x2, el.y2);
  ctx.lineTo(
    el.x2 - size * Math.cos(angle - Math.PI / 7),
    el.y2 - size * Math.sin(angle - Math.PI / 7),
  );
  ctx.moveTo(el.x2, el.y2);
  ctx.lineTo(
    el.x2 - size * Math.cos(angle + Math.PI / 7),
    el.y2 - size * Math.sin(angle + Math.PI / 7),
  );
  ctx.stroke();
}

/** A freehand stroke, smoothed with quadratic curves through the midpoints. */
function stroke(ctx: CanvasRenderingContext2D, points: readonly number[], width: number) {
  const n = points.length / 2;
  const x0 = points[0] ?? 0;
  const y0 = points[1] ?? 0;
  if (n === 1) {
    ctx.beginPath();
    ctx.arc(x0, y0, width / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  for (let i = 1; i < n - 1; i++) {
    const x = points[i * 2] ?? 0;
    const y = points[i * 2 + 1] ?? 0;
    const nx = points[i * 2 + 2] ?? 0;
    const ny = points[i * 2 + 3] ?? 0;
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  ctx.lineTo(points[(n - 1) * 2] ?? 0, points[(n - 1) * 2 + 1] ?? 0);
  ctx.stroke();
}

export function drawElement(ctx: CanvasRenderingContext2D, el: BoardElement, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = el.color;
  ctx.fillStyle = el.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (el.type) {
    case 'stroke':
      ctx.lineWidth = el.width;
      stroke(ctx, el.points, el.width);
      break;
    case 'line':
    case 'arrow':
      ctx.lineWidth = el.width;
      ctx.beginPath();
      ctx.moveTo(el.x1, el.y1);
      ctx.lineTo(el.x2, el.y2);
      ctx.stroke();
      if (el.type === 'arrow') arrowHead(ctx, el);
      break;
    case 'rect':
      ctx.lineWidth = el.width;
      ctx.strokeRect(
        Math.min(el.x1, el.x2),
        Math.min(el.y1, el.y2),
        Math.abs(el.x2 - el.x1),
        Math.abs(el.y2 - el.y1),
      );
      break;
    case 'ellipse':
      ctx.lineWidth = el.width;
      ctx.beginPath();
      ctx.ellipse(
        (el.x1 + el.x2) / 2,
        (el.y1 + el.y2) / 2,
        Math.abs(el.x2 - el.x1) / 2,
        Math.abs(el.y2 - el.y1) / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
    case 'text':
      ctx.font = `${el.size}px ${TEXT_FONT}`;
      ctx.textBaseline = 'top';
      el.text.split('\n').forEach((line, i) => ctx.fillText(line, el.x, el.y + i * el.size * 1.25));
      break;
  }
  ctx.restore();
}

/** Another participant's pointer, with their name. */
export function drawCursor(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  name: string,
  color: string,
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 4, y + 18);
  ctx.lineTo(x + 8.5, y + 12.5);
  ctx.lineTo(x + 15, y + 12);
  ctx.closePath();
  ctx.fill();
  ctx.font = `600 13px ${TEXT_FONT}`;
  const width = ctx.measureText(name).width + 10;
  ctx.fillRect(x + 12, y + 16, width, 20);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, x + 17, y + 26);
  ctx.restore();
}
