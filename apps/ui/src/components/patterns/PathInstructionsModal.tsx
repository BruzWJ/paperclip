import { useState } from "react";
import { Apple, Monitor, Terminal } from "lucide-react";
import * as DialogUI from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import * as TabsUI from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { OpenStateProps } from "@/lib/presentation-contracts";

type Platform = "mac" | "windows" | "linux";

const platforms: { id: Platform; label: string; icon: typeof Apple }[] = [
  { id: "mac", label: "macOS", icon: Apple },
  { id: "windows", label: "Windows", icon: Monitor },
  { id: "linux", label: "Linux", icon: Terminal },
];

const instructions: Record<Platform, { steps: string[]; tip?: string }> = {
  mac: {
    steps: [
      "Open Finder and navigate to the folder.",
      "Right-click (or Control-click) the folder.",
      'Hold the Option (⌥) key — "Copy" changes to "Copy as Pathname".',
      'Click "Copy as Pathname", then paste here.',
    ],
    tip: "You can also open Terminal, type cd, drag the folder into the terminal window, and press Enter. Then type pwd to see the full path.",
  },
  windows: {
    steps: [
      "Open File Explorer and navigate to the folder.",
      "Click in the address bar at the top — the full path will appear.",
      "Copy the path, then paste here.",
    ],
    tip: 'Alternatively, hold Shift and right-click the folder, then select "Copy as path".',
  },
  linux: {
    steps: [
      "Open a terminal and navigate to the directory with cd.",
      "Run pwd to print the full path.",
      "Copy the output and paste here.",
    ],
    tip: "In most file managers, Ctrl+L reveals the full path in the address bar.",
  },
};

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("mac")) return "mac";
  if (ua.includes("win")) return "windows";
  return "linux";
}

export function PathInstructionsModal({ open, onOpenChange }: OpenStateProps) {
  const [platform, setPlatform] = useState<Platform>(detectPlatform);

  const current = instructions[platform];

  return (
    <DialogUI.Dialog open={open} onOpenChange={onOpenChange}>
      <DialogUI.DialogContent className="sm:max-w-md">
        <DialogUI.DialogHeader>
          <DialogUI.DialogTitle>How to get a full path</DialogUI.DialogTitle>
          <DialogUI.DialogDescription>
            Paste the absolute path (e.g.{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">/Users/you/project</code>) into the input
            field.
          </DialogUI.DialogDescription>
        </DialogUI.DialogHeader>

        <TabsUI.Tabs value={platform} onValueChange={(value) => setPlatform(value as Platform)}>
          <TabsUI.TabsList className="w-full">
            {platforms.map((item) => (
              <TabsUI.TabsTrigger key={item.id} value={item.id} className="py-1 text-xs">
                <item.icon className="size-3.5" />
                {item.label}
              </TabsUI.TabsTrigger>
            ))}
          </TabsUI.TabsList>
        </TabsUI.Tabs>

        <ol className="space-y-2 text-sm">
          {current.steps.map((step, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-muted-foreground font-mono text-xs mt-0.5 shrink-0">{i + 1}.</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        {current.tip && (
          <Alert>
            <AlertTitle>Tip</AlertTitle>
            <AlertDescription>{current.tip}</AlertDescription>
          </Alert>
        )}
      </DialogUI.DialogContent>
    </DialogUI.Dialog>
  );
}

export function ChoosePathButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className={cn("h-auto shrink-0 py-0.5 text-muted-foreground", className)}
        onClick={() => setOpen(true)}
      >
        Choose
      </Button>
      <PathInstructionsModal open={open} onOpenChange={setOpen} />
    </>
  );
}
