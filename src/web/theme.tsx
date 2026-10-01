import { useSyncExternalStore } from "react";

/** Must match the theme names in scripts/themes.py (and the generated themes.css). */
export const THEMES = [
  ["tokyo", "Tokyo Night"],
  ["catppuccin", "Catppuccin Mocha"],
  ["starship", "Starship"],
  ["dracula", "Dracula"],
  ["gruvbox", "Gruvbox Dark"],
  ["github-light", "GitHub Light"],
] as const;
export type ThemeId = (typeof THEMES)[number][0];

/** Shiki theme for code in each viewer theme. Starship has no Shiki theme; vitesse-black is closest. */
export const SHIKI_THEMES: Record<
  ThemeId,
  { readonly name: string; readonly type: "dark" | "light" }
> = {
  tokyo: { name: "tokyo-night", type: "dark" },
  catppuccin: { name: "catppuccin-mocha", type: "dark" },
  starship: { name: "vitesse-black", type: "dark" },
  dracula: { name: "dracula", type: "dark" },
  gruvbox: { name: "gruvbox-dark-medium", type: "dark" },
  "github-light": { name: "github-light", type: "light" },
};

const THEME_KEY = "toolreader.theme";
const isTheme = (v: string | null): v is ThemeId => THEMES.some(([id]) => id === v);

let current: ThemeId = "tokyo";
const listeners = new Set<() => void>();

function setTheme(theme: ThemeId) {
  current = theme;
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.dataset.theme = theme;
  for (const listener of listeners) listener();
}

/** Applies the saved theme; called once before the first render to avoid a flash. */
export function applySavedTheme(): void {
  const saved = localStorage.getItem(THEME_KEY);
  current = isTheme(saved) ? saved : "tokyo";
  document.documentElement.dataset.theme = current;
}

export function useTheme(): ThemeId {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export function ThemePicker() {
  const theme = useTheme();
  return (
    <select
      className="theme-picker"
      aria-label="Theme"
      value={theme}
      onChange={(e) => {
        if (isTheme(e.target.value)) setTheme(e.target.value);
      }}
    >
      {THEMES.map(([id, label]) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </select>
  );
}
