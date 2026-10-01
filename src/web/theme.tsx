import { useState } from "react";

/** Must match the theme names in scripts/themes.py (and the generated themes.css). */
export const THEMES = [
  ["tokyo", "Tokyo Night"],
  ["catppuccin", "Catppuccin Mocha"],
  ["starship", "Starship"],
  ["dracula", "Dracula"],
  ["gruvbox", "Gruvbox Dark"],
  ["github-light", "GitHub Light"],
] as const;
type ThemeId = (typeof THEMES)[number][0];

const THEME_KEY = "toolreader.theme";

const isTheme = (v: string | null): v is ThemeId => THEMES.some(([id]) => id === v);

/** Applies the saved theme; called once before the first render to avoid a flash. */
export function applySavedTheme(): ThemeId {
  const saved = localStorage.getItem(THEME_KEY);
  const theme = isTheme(saved) ? saved : "tokyo";
  document.documentElement.dataset.theme = theme;
  return theme;
}

export function ThemePicker() {
  const [theme, setTheme] = useState<ThemeId>(applySavedTheme);
  return (
    <select
      className="theme-picker"
      aria-label="Theme"
      value={theme}
      onChange={(e) => {
        const next = e.target.value;
        if (!isTheme(next)) return;
        localStorage.setItem(THEME_KEY, next);
        document.documentElement.dataset.theme = next;
        setTheme(next);
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
