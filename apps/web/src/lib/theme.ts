import { create } from 'zustand';

/**
 * Light, dark, or follow the system (the default). An explicit choice sets
 * `data-theme` on <html>, which the palette in styles/index.css obeys over
 * the system preference; "system" removes it.
 */
export type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'confluence-theme';
const THEMES: readonly Theme[] = ['system', 'light', 'dark'];

function stored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return THEMES.includes(value as Theme) ? (value as Theme) : 'system';
  } catch {
    return 'system'; // storage blocked (private mode): just follow the system
  }
}

function apply(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset['theme'];
  else document.documentElement.dataset['theme'] = theme;
}

export const useTheme = create<{ theme: Theme; setTheme: (theme: Theme) => void }>()((set) => ({
  theme: stored(),
  setTheme: (theme) => {
    apply(theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Not persisted; still applied for this visit.
    }
    set({ theme });
  },
}));

// At import, before the first paint (main.tsx imports this early), so a dark
// choice never flashes light.
apply(useTheme.getState().theme);
