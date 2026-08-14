import { useCallback } from "react";

import { ThemeSwitcher, type ThemeSwitcherProps } from "@/components/kibo-ui/theme-switcher";
import { type ThemePreference, useTheme } from "@/context/ThemeContext";

export interface ThemeSelectorProps extends Pick<ThemeSwitcherProps, "className"> {
  onChange?: (theme: ThemePreference) => void;
}

/** Application theme preference adapter backed by Kibo's ThemeSwitcher. */
export function ThemeSelector({ className, onChange }: ThemeSelectorProps) {
  const { preference, setTheme } = useTheme();
  const handleChange = useCallback(
    (nextTheme: ThemePreference) => {
      setTheme(nextTheme);
      onChange?.(nextTheme);
    },
    [onChange, setTheme],
  );

  return <ThemeSwitcher className={className} value={preference ?? "system"} onChange={handleChange} />;
}
