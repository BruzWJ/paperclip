import { createContext, useContext, type ReactNode } from "react";
import { Link, type RegisteredRouter, type ValidateLinkOptions } from "@tanstack/react-router";
import { SIDEBAR_SCROLL_RESET_STATE } from "@/lib/navigation-scroll";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { useSidebar } from "@/context/SidebarContext";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";

/**
 * Forces the full-label (non-rail) presentation for any `SidebarNavItem`
 * rendered beneath it, regardless of the global `useSidebar().collapsed` state.
 *
 * Takeover routes (PAP-10695) collapse the app `<Sidebar/>` to its 64px rail
 * and render the contextual nav in a fixed-width secondary sidebar. That pane
 * is always wide enough for labels, but its `SidebarNavItem` children still
 * read the *global* `collapsed=true` and would otherwise render icon-only —
 * leaving the settings nav unreadable (PAP-10700). Wrapping the pane in this
 * provider decouples its items from the global rail collapse.
 */
const SidebarNavExpandedContext = createContext(false);

export function SidebarNavExpandedProvider({ children }: { children: ReactNode }) {
  return <SidebarNavExpandedContext.Provider value={true}>{children}</SidebarNavExpandedContext.Provider>;
}

export function useSidebarNavExpanded() {
  return useContext(SidebarNavExpandedContext);
}

interface SidebarNavItemProps<TRouter extends RegisteredRouter = RegisteredRouter, TOptions = unknown> {
  linkOptions: ValidateLinkOptions<TRouter, TOptions>;
  label: string;
  icon?: LucideIcon;
  /**
   * Pre-rendered icon element for rows whose icon isn't a plain Lucide
   * component (e.g. the agent rows' `AgentIcon`). Takes precedence over `icon`;
   * the caller owns its sizing/color classes.
   */
  iconNode?: ReactNode;
  end?: boolean;
  className?: string;
  labelClassName?: string;
  badge?: number;
  badgeTone?: "default" | "danger" | "warning";
  /**
   * Accessible noun for the numeric badge when collapsed to the rail, where the
   * count is rendered as a dot (e.g. `badgeLabel="unread"` → "Inbox, 28 unread").
   */
  badgeLabel?: string;
  textBadge?: string;
  textBadgeTone?: "default" | "amber";
  alert?: boolean;
  liveCount?: number;
  /**
   * Overrides the router link's own route matching for rows whose active state is
   * computed externally (agent rows match `/agents/:ref` across tab suffixes).
   */
  active?: boolean;
  /** Rendered after the label, before the right-aligned status cluster. */
  trailing?: ReactNode;
  /** Accessible text for `trailing` status content, surfaced in the collapsed rail (where `trailing` is hidden). */
  trailingLabel?: string;
  /** Rendered inside the right-aligned status cluster, before the live dot. */
  liveAccessory?: ReactNode;
  /** The caller already supplies the SidebarMenuItem to host row actions. */
  withinMenuItem?: boolean;
}

export function SidebarNavItem<TRouter extends RegisteredRouter, TOptions>(
  props: SidebarNavItemProps<TRouter, TOptions>,
): ReactNode;
export function SidebarNavItem({
  linkOptions,
  label,
  icon: Icon,
  iconNode,
  end,
  className,
  labelClassName,
  badge,
  badgeTone = "default",
  badgeLabel,
  textBadge,
  textBadgeTone = "default",
  alert = false,
  liveCount,
  active,
  trailing,
  trailingLabel,
  liveAccessory,
  withinMenuItem = false,
}: SidebarNavItemProps) {
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  // A fixed-width contextual pane forces full labels even
  // when the global app sidebar is collapsed to its rail (PAP-10700).
  const forceExpanded = useSidebarNavExpanded();
  // The icon-only rail presentation only applies when pinned collapsed and not
  // peeking; a peek/expanded panel — or an expanded contextual pane — restores
  // the full label + badge.
  const rail = collapsed && !peeking && !forceExpanded;

  const hasBadge = badge != null && badge > 0;
  const hasLive = liveCount != null && liveCount > 0;

  // Accessible text equivalent for the collapsed dot indicator. The visible
  // label is `sr-only` in the rail, so the count must be surfaced here.
  const railStatusText = hasLive
    ? `${liveCount} live`
    : hasBadge
      ? `${badge}${badgeLabel ? ` ${badgeLabel}` : ""}`
      : alert
        ? "attention needed"
        : undefined;
  const railAriaLabel =
    !rail || (!railStatusText && !trailingLabel)
      ? undefined
      : `${label}${railStatusText ? `, ${railStatusText}` : ""}${trailingLabel ? `, ${trailingLabel}` : ""}`;

  const link = (
    <SidebarMenuButton
      asChild
      isActive={active}
      tooltip={rail ? label : undefined}
      className={cn(rail && "px-2", className)}
    >
      <Link
        {...linkOptions}
        state={SIDEBAR_SCROLL_RESET_STATE}
        activeOptions={{ exact: end }}
        activeProps={{
          className: active === false ? undefined : "bg-accent text-accent-foreground",
        }}
        inactiveProps={{
          className: active === true ? "bg-accent text-accent-foreground" : undefined,
        }}
        aria-label={railAriaLabel}
        onClick={() => {
          if (isMobile) setSidebarOpen(false);
        }}
      >
        <span className="relative shrink-0">
          {iconNode ?? (Icon ? <Icon className="h-4 w-4" /> : null)}
          {alert && (
            <Badge
              variant="destructive"
              className="absolute -right-0.5 -top-0.5 size-2 p-0"
              aria-hidden="true"
            />
          )}
          {rail && !alert && (hasLive || hasBadge) ? (
            <Badge
              variant={
                badgeTone === "danger" ? "destructive" : badgeTone === "warning" ? "secondary" : "default"
              }
              className={cn("absolute -right-0.5 -top-0.5 size-2 p-0", hasLive && "animate-pulse")}
              aria-hidden="true"
            />
          ) : null}
        </span>
        <span
          className={
            rail ? SIDEBAR_RAIL_HIDDEN_LABEL : cn("min-w-0 flex-1 truncate text-left", labelClassName)
          }
        >
          {label}
        </span>
        {!rail && trailing}
        {!rail && textBadge ? (
          <Badge variant={textBadgeTone === "amber" ? "secondary" : "outline"}>{textBadge}</Badge>
        ) : null}
        {!rail && liveAccessory}
        {!rail && hasLive ? <Badge variant="secondary">{liveCount} live</Badge> : null}
        {!rail && hasBadge ? (
          <Badge variant={badgeTone === "danger" ? "destructive" : "secondary"} className="ml-auto">
            {badge}
          </Badge>
        ) : null}
      </Link>
    </SidebarMenuButton>
  );
  return withinMenuItem ? link : <SidebarMenuItem>{link}</SidebarMenuItem>;
}
