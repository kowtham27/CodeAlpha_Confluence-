import type { ReactNode } from 'react';
import { useTheme, type Theme } from '../lib/theme';

const icon = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const OPTIONS: { value: Theme; label: string; glyph: ReactNode }[] = [
  {
    value: 'system',
    label: 'System theme',
    glyph: (
      <svg {...icon}>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </svg>
    ),
  },
  {
    value: 'light',
    label: 'Light theme',
    glyph: (
      <svg {...icon}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark theme',
    glyph: (
      <svg {...icon}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    ),
  },
];

/** Three-way switch: follow the system, or force light or dark. */
export function ThemeSwitcher() {
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-lg bg-surface-sunken p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={theme === o.value}
          aria-label={o.label}
          title={o.label}
          onClick={() => setTheme(o.value)}
          className={`flex size-7 items-center justify-center rounded-md transition-colors ${
            theme === o.value
              ? 'bg-surface-raised text-ink shadow-sm'
              : 'text-ink-muted hover:text-ink'
          }`}
        >
          {o.glyph}
        </button>
      ))}
    </div>
  );
}
