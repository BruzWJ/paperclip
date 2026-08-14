import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { ThemeProvider as NextThemesProvider, useTheme as useNextTheme } from "next-themes";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "@/lib/keyboardShortcuts";

type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const THEME_STORAGE_KEY = "paperclip.theme";
const DARK_THEME_COLOR = "#18181b";
const LIGHT_THEME_COLOR = "#ffffff";

function resolvedTheme(value: string | undefined): Theme {
  if (value === "light" || value === "dark") return value;
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function isThemeShortcutTextInputTarget(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return isKeyboardShortcutTextInputTarget(target);
}

function ThemeEffects() {
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const themeColorMeta = document.querySelector('meta[name="theme-color"]');
    if (themeColorMeta instanceof HTMLMetaElement) {
      themeColorMeta.setAttribute("content", theme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
    }
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isThemeShortcut =
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "d";
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        !isThemeShortcut ||
        isThemeShortcutTextInputTarget(event.target) ||
        hasBlockingShortcutDialog()
      ) {
        return;
      }

      event.preventDefault();
      setTheme(theme === "dark" ? "light" : "dark");
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setTheme, theme]);

  return null;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableColorScheme
      enableSystem
      storageKey={THEME_STORAGE_KEY}
    >
      <ThemeEffects />
      {children}
    </NextThemesProvider>
  );
}

export function useTheme() {
  const nextTheme = useNextTheme();
  const theme = resolvedTheme(nextTheme.resolvedTheme);
  const preference: ThemePreference =
    nextTheme.theme === "light" || nextTheme.theme === "dark" ? nextTheme.theme : "system";
  const setTheme = useCallback((value: ThemePreference) => nextTheme.setTheme(value), [nextTheme.setTheme]);
  const toggleTheme = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [setTheme, theme]);

  return useMemo(
    () => ({ theme, preference, setTheme, toggleTheme }),
    [preference, setTheme, theme, toggleTheme],
  );
}
