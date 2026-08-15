import { useEffect, useState } from "react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useTheme } from "@/context/ThemeContext";
import { openCompanyCommandMenu } from "@/lib/command-menu-bridge";
import { Monitor, Moon, Sun } from "lucide-react";

/**
 * App-shell command menu. Always mounted from main.tsx so operators can reach
 * theme commands outside a company route. When the board palette is mounted it
 * claims Cmd/Ctrl+K instead of opening this fallback.
 */
export function AppCommandMenu() {
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (openCompanyCommandMenu()) return;
        setOpen((current) => !current);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search commands..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Appearance">
          <CommandItem
            onSelect={() => {
              setTheme(theme === "dark" ? "light" : "dark");
              setOpen(false);
            }}
          >
            {theme === "dark" ? <Sun  data-icon="inline-start"/> : <Moon  data-icon="inline-start"/>}
            Toggle theme
          </CommandItem>
          <CommandItem
            onSelect={() => {
              setTheme("system");
              setOpen(false);
            }}
          >
            <Monitor  data-icon="inline-start"/>
            Use system theme
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
