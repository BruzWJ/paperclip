import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { CHROMELESS_DISPLAY_MODES, isChromelessDisplayMode } from "@/lib/pwa-display-mode";

export function StandaloneBrowserControls({ mobile }: { mobile: boolean }) {
  const [chromeless, setChromeless] = useState(() =>
    typeof window !== "undefined" && mobile ? isChromelessDisplayMode() : false,
  );

  useEffect(() => {
    if (!mobile || typeof window === "undefined") {
      setChromeless(false);
      return;
    }

    const update = () => setChromeless(isChromelessDisplayMode());

    update();
    if (typeof window.matchMedia !== "function") return;

    const mediaQueries = CHROMELESS_DISPLAY_MODES.map((mode) => window.matchMedia(`(display-mode: ${mode})`));
    if (mediaQueries.every((media) => typeof media.addEventListener === "function")) {
      mediaQueries.forEach((media) => media.addEventListener("change", update));
      return () => mediaQueries.forEach((media) => media.removeEventListener("change", update));
    }

    mediaQueries.forEach((media) => media.addListener(update));
    return () => mediaQueries.forEach((media) => media.removeListener(update));
  }, [mobile]);

  const refresh = useCallback(() => {
    window.location.reload();
  }, []);

  const share = useCallback(async () => {
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title || "Paperclip", url });
        return;
      }
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        toast.success("Link copied");
        return;
      }
      toast.warning("Sharing is unavailable", { description: url });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("Share failed", {
        description: "Try opening the page in your browser.",
      });
    }
  }, []);

  const openInBrowser = useCallback(() => {
    window.open(window.location.href, "_blank", "noopener,noreferrer");
  }, []);

  if (!mobile || !chromeless) return null;

  return (
    <div className="flex h-10 items-center justify-end gap-1 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
      <ButtonGroup>
        {[
          { label: "Refresh", icon: RefreshCw, action: refresh },
          { label: "Share", icon: Share2, action: share },
          {
            label: "Open in Browser",
            icon: ExternalLink,
            action: openInBrowser,
          },
        ].map(({ label, icon: Icon, action }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-8 text-muted-foreground hover:text-foreground"
                aria-label={label}
                onClick={() => void action()}
              >
                <Icon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </ButtonGroup>
    </div>
  );
}
