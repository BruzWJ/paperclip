import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, LogOut, Megaphone, UserRound, UserRoundPen } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useSidebar } from "@/context/SidebarContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { SidebarServerInfo } from "./-SidebarServerInfo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ThemeSelector } from "@/components/patterns/ThemeSelector";
import type { ControlledOpenStateProps } from "@/lib/presentation-contracts";

const DOCS_URL = "https://docs.paperclip.ing/";
const FEEDBACK_URL = "https://paperclip.ing/feedback";

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function SidebarAccountMenu({ open: controlledOpen, onOpenChange }: ControlledOpenStateProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const queryClient = useQueryClient();
  const companyId = useCompanyRouteId();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
    },
  });

  const displayName = session?.user.name?.trim() || session?.user.email?.trim() || "Account";
  const secondaryLabel = session?.user.email?.trim() || "Signed in";
  const initials = deriveInitials(displayName);
  const userId = session?.user.id;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  return (
    <div className="border-t border-r border-border bg-background px-3 py-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-start px-3 py-2"
            aria-label="Open account menu"
          >
            <Avatar size="sm">
              {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className={cn("min-w-0 flex-1 truncate", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}>
              {displayName}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          className="w-(--sz-277px) max-w-(--sz-calc-24) overflow-hidden rounded-md border-border p-0 shadow-2xl"
        >
          <div className="p-2">
            <div className="flex items-start gap-3">
              <div className="rounded-sm border-4 border-popover bg-popover p-0.5 shadow-sm">
                <Avatar size="lg">
                  {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </div>
              <div className="min-w-0 flex-1 pt-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-foreground">{displayName}</h2>
                  <Badge
                    variant="ghost"
                    className="bg-accent text-(length:--text-nano) font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Account
                  </Badge>
                </div>
                <p className="truncate text-sm text-muted-foreground">{secondaryLabel}</p>
              </div>
            </div>

            <div className="mt-4 space-y-1">
              {userId ? (
                <Button
                  asChild
                  variant="ghost"
                  className="h-auto w-full justify-start gap-3 rounded-sm px-3 py-3 text-left whitespace-normal"
                >
                  <Link
                    to="/$companyId/u/$userId"
                    params={{ companyId, userId }}
                    onClick={closeNavigationChrome}
                  >
                    <span className="mt-0.5 rounded-sm border border-border bg-background/70 p-2 text-muted-foreground">
                      <UserRound className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">View profile</span>
                      <span className="block text-xs text-muted-foreground">
                        Open your activity, task, and usage ledger.
                      </span>
                    </span>
                  </Link>
                </Button>
              ) : null}
              <Button
                asChild
                variant="ghost"
                className="h-auto w-full justify-start gap-3 rounded-sm px-3 py-3 text-left whitespace-normal"
              >
                <Link
                  to="/$companyId/company/settings/instance/profile"
                  params={{ companyId }}
                  onClick={closeNavigationChrome}
                >
                  <span className="mt-0.5 rounded-sm border border-border bg-background/70 p-2 text-muted-foreground">
                    <UserRoundPen className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">Edit profile</span>
                    <span className="block text-xs text-muted-foreground">
                      Update your display name and avatar.
                    </span>
                  </span>
                </Link>
              </Button>
              <Button
                asChild
                variant="ghost"
                className="h-auto w-full justify-start gap-3 rounded-sm px-3 py-3 text-left whitespace-normal"
              >
                <a href={DOCS_URL} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                  <span className="mt-0.5 rounded-sm border border-border bg-background/70 p-2 text-muted-foreground">
                    <BookOpen className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">Documentation</span>
                    <span className="block text-xs text-muted-foreground">
                      Open Paperclip docs in a new tab.
                    </span>
                  </span>
                </a>
              </Button>
              <Button
                asChild
                variant="ghost"
                className="h-auto w-full justify-start gap-3 rounded-sm px-3 py-3 text-left whitespace-normal"
              >
                <a href={FEEDBACK_URL} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
                  <span className="mt-0.5 rounded-sm border border-border bg-background/70 p-2 text-muted-foreground">
                    <Megaphone className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">Feedback</span>
                    <span className="block text-xs text-muted-foreground">
                      Share feedback or report a problem.
                    </span>
                  </span>
                </a>
              </Button>
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-sm font-medium">Theme</span>
                <ThemeSelector onChange={() => setOpen(false)} />
              </div>
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  "h-auto w-full items-start justify-start gap-3 px-3 py-3 text-left",
                  signOutMutation.isPending && "cursor-not-allowed opacity-60",
                )}
                onClick={() => signOutMutation.mutate()}
                disabled={signOutMutation.isPending}
                aria-busy={signOutMutation.isPending}
              >
                <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
                  <LogOut className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span aria-live="polite" className="block text-sm font-medium text-foreground">
                    {signOutMutation.isPending ? "Signing out..." : "Sign out"}
                  </span>
                  <span className="block text-xs text-muted-foreground">End this browser session.</span>
                </span>
              </Button>
              <SidebarServerInfo />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
