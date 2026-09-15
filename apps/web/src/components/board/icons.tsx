/** Whiteboard tool icons. Decorative: every button carries an aria-label. */

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const PenIcon = () => (
  <svg {...base}>
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </svg>
);

export const LineIcon = () => (
  <svg {...base}>
    <path d="M5 19L19 5" />
  </svg>
);

export const ArrowIcon = () => (
  <svg {...base}>
    <path d="M5 19L19 5M10 5h9v9" />
  </svg>
);

export const RectIcon = () => (
  <svg {...base}>
    <rect x="4" y="6" width="16" height="12" rx="1" />
  </svg>
);

export const EllipseIcon = () => (
  <svg {...base}>
    <ellipse cx="12" cy="12" rx="9" ry="6" />
  </svg>
);

export const TextIcon = () => (
  <svg {...base}>
    <path d="M5 6V4h14v2M12 4v16M9 20h6" />
  </svg>
);

export const EraserIcon = () => (
  <svg {...base}>
    <path d="M20 20H8l-5-5a2 2 0 0 1 0-3l9-9a2 2 0 0 1 3 0l6 6a2 2 0 0 1 0 3l-8 8M6 11l7 7" />
  </svg>
);

export const UndoIcon = () => (
  <svg {...base}>
    <path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />
  </svg>
);

export const RedoIcon = () => (
  <svg {...base}>
    <path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />
  </svg>
);

export const ExportIcon = () => (
  <svg {...base}>
    <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
  </svg>
);

export const WhiteboardIcon = () => (
  <svg {...base} width={20} height={20}>
    <rect x="3" y="4" width="18" height="12" rx="1.5" />
    <path d="M7 12l3-3 2 2 4-4M12 16v4M8 20h8" />
  </svg>
);
