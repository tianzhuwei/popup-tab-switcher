import { createSignal, onCleanup } from "solid-js";
import { ThemeMode } from "./settings";

/**
 * Tracks the OS color-scheme and resolves the effective theme.
 * When `themeMode` is "auto" the result follows the system; otherwise the
 * manual "light"/"dark" choice wins.
 */
export function createThemeMode(themeMode: () => ThemeMode) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const [systemDark, setSystemDark] = createSignal(media.matches);

  const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
  media.addEventListener("change", onChange);
  onCleanup(() => media.removeEventListener("change", onChange));

  return (): boolean => {
    const mode = themeMode();
    if (mode === "auto") {
      return systemDark();
    }
    return mode === "dark";
  };
}
