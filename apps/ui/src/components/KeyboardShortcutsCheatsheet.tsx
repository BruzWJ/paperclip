import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Item, ItemActions, ItemGroup } from "@/components/ui/item";

interface ShortcutEntry {
  keys: string[];
  label: string;
  /** Render keys as a simultaneous chord (joined with "+") rather than a
   *  "then" sequence. */
  combo?: boolean;
}

// Platform-appropriate label for the Cmd/Ctrl modifier so the cheatsheet shows
// the same key the user actually presses (re-pointed in the collapsible sidebar
// work — Cmd/Ctrl+B toggles the rail).
function getPlatformLabel() {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return nav.userAgentData?.platform || navigator.userAgent || "";
}

const META_KEY = /Mac|iPhone|iPad|iPod/.test(getPlatformLabel()) ? "⌘" : "Ctrl";

interface ShortcutSection {
  title: string;
  shortcuts: ShortcutEntry[];
}

const sections: ShortcutSection[] = [
  {
    title: "Inbox",
    shortcuts: [
      { keys: ["j"], label: "Move down" },
      { keys: ["↓"], label: "Move down" },
      { keys: ["k"], label: "Move up" },
      { keys: ["↑"], label: "Move up" },
      { keys: ["←"], label: "Collapse selected group" },
      { keys: ["→"], label: "Expand selected group" },
      { keys: ["Enter"], label: "Open selected item" },
      { keys: ["a"], label: "Archive item" },
      { keys: ["y"], label: "Archive item" },
      { keys: ["r"], label: "Mark as read" },
      { keys: ["U"], label: "Mark as unread" },
    ],
  },
  {
    title: "Task detail",
    shortcuts: [
      { keys: ["y"], label: "Quick-archive back to inbox" },
      { keys: ["g", "i"], label: "Go to inbox" },
      { keys: ["g", "c"], label: "Focus comment composer" },
    ],
  },
  {
    title: "Decisions",
    shortcuts: [
      { keys: ["j"], label: "Move down" },
      { keys: ["↓"], label: "Move down" },
      { keys: ["k"], label: "Move up" },
      { keys: ["↑"], label: "Move up" },
      { keys: ["Enter"], label: "Open or close selected decision" },
      { keys: ["x"], label: "Dismiss selected decision" },
    ],
  },
  {
    title: "Global",
    shortcuts: [
      { keys: ["/"], label: "Search current page or quick search" },
      { keys: ["c"], label: "New task" },
      { keys: ["["], label: "Toggle sidebar" },
      {
        keys: [META_KEY, "B"],
        label: "Collapse or expand sidebar",
        combo: true,
      },
      { keys: ["]"], label: "Toggle panel" },
      { keys: ["?"], label: "Show keyboard shortcuts" },
    ],
  },
];

export function KeyboardShortcutsCheatsheetContent() {
  return (
    <>
      <div className="divide-y divide-border border-t border-border">
        {sections.map((section) => (
          <div key={section.title} className="px-5 py-3">
            <h3 className="mb-2 text-(length:--text-micro) font-semibold uppercase tracking-wider text-muted-foreground">
              {section.title}
            </h3>
            <ItemGroup className="gap-1.5">
              {section.shortcuts.map((shortcut) => (
                <Item
                  key={shortcut.label + shortcut.keys.join()}
                  size="sm"
                  className="flex-nowrap justify-between border-0 px-0 py-0"
                >
                  <span className="text-sm text-foreground/90">{shortcut.label}</span>
                  <ItemActions>
                    {shortcut.keys.map((key, i) => (
                      <span key={key} className="flex items-center gap-1">
                        {i > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {shortcut.combo ? "+" : "then"}
                          </span>
                        )}
                        <Kbd className="h-6 min-w-6 border border-border px-1.5 font-mono text-foreground shadow-(--shadow-extract-10)">
                          {key}
                        </Kbd>
                      </span>
                    ))}
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-5 py-3">
        <p className="text-xs text-muted-foreground">
          Press{" "}
          <Kbd className="h-6 min-w-6 border border-border px-1.5 font-mono text-foreground shadow-(--shadow-extract-10)">
            Esc
          </Kbd>{" "}
          to close &middot; Shortcuts are disabled in text fields
        </p>
      </div>
    </>
  );
}

export function KeyboardShortcutsCheatsheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={false}>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <KeyboardShortcutsCheatsheetContent />
      </DialogContent>
    </Dialog>
  );
}
