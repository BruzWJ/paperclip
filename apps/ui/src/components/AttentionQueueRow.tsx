import type { AttentionItem } from "@paperclipai/shared";
import { ChevronDown, ChevronRight, ExternalLink, MoreHorizontal, RotateCcw, X } from "lucide-react";
import { memo } from "react";
import { attentionDetailImages, attentionDetailLine, isInlineResolvable, sourceMeta } from "../lib/attention";
import { cn, relativeTime } from "../lib/utils";
import { CompanyBoardLink } from "./CompanyBoardLink";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { Item, ItemActions, ItemContent } from "./ui/item";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

import { CompactDecisionActions, InlineResolver, collectCompactActions } from "./AttentionQueueDecisions";

import { SnoozeSubmenu, reappearLabel } from "./AttentionQueueSnooze";

import { ExpandedImages, ProjectMeta, ThumbnailStack } from "./AttentionQueueMedia";

// Decision-action buttons: a comfortable tap target when the row is narrow
// (h-9 / text-sm), shrinking back to the dense pill (h-6 / text-xs) once the
// row's own container is wide enough (`@xl` ≈ 576px). Container-query driven so
// the row also reflows correctly inside narrow side panels, not just on phones.
const ACTION_BTN = "h-9 gap-1.5 px-3 text-sm @xl:h-6 @xl:gap-1 @xl:px-2 @xl:text-xs";

interface AttentionQueueRowProps {
  item: AttentionItem;
  companyId: string;
  expanded: boolean;
  /** Receives the row's item so the parent can pass one stable callback for every row. */
  onToggleExpand: (item: AttentionItem) => void;
  onDismiss?: (item: AttentionItem) => void;
  onSnooze?: (item: AttentionItem, snoozedUntil: string) => void;
  /** Restore a snoozed/dismissed row (curtain variant only). */
  onRestore?: (item: AttentionItem) => void;
  /** "active" renders the live queue row; "hidden" renders a curtain row. */
  variant?: "active" | "hidden";
  selected?: boolean;
}

/**
 * Memoized (PAP-13784): the queue renders every feed row in one flat list, so
 * without memo a single keyboard-selection or expand toggle re-renders every
 * row (each carrying a Radix dropdown + mutation). All props are stable or
 * primitive; `item` identity is preserved across refetches by react-query's
 * structural sharing.
 */
export const AttentionQueueRow = memo(function AttentionQueueRow({
  item,
  companyId,
  expanded,
  onToggleExpand,
  onDismiss,
  onSnooze,
  onRestore,
  variant = "active",
  selected = false,
}: AttentionQueueRowProps) {
  const meta = sourceMeta(item.sourceKind);
  const dismissHandler = onDismiss;
  const snoozeHandler = onSnooze;
  const Icon = meta.icon;
  const isHidden = variant === "hidden";
  const inline = !isHidden && isInlineResolvable(item);
  const routeTarget = item.subject.routeTarget;
  const snoozedUntil = item.dismissal?.kind === "snooze" ? item.dismissal.snoozedUntil : null;
  const detailLine = attentionDetailLine(item) ?? item.whyNow;
  const images = attentionDetailImages(item);
  const hasImages = images.length > 0;
  // The task (or source) this row points at — used as the target for the
  // "n more" affordance in the expanded gallery.
  const imageTaskTarget =
    item.relatedTask?.routeTarget?.kind === "task"
      ? item.relatedTask.routeTarget
      : routeTarget?.kind === "task"
        ? routeTarget
        : null;
  // Inline-resolvable active rows expand to reveal their resolver; rows with
  // images expand to reveal a larger gallery (PAP-13544). Either case gives a
  // header/thumbnail click somewhere to go. Non-inline, image-less rows keep the
  // explicit Open button and never toggle on a stray click.
  const expandable = inline || (!isHidden && hasImages);
  // Which rows contribute an action bar. Inline rows carry compact decision
  // verbs; deep-link rows carry an Open button; curtain rows carry Restore.
  const compactActions = !isHidden ? collectCompactActions(item) : [];
  const showCompact = !expanded && compactActions.length > 0;
  const showOpen = !inline && !!routeTarget;
  const showRestore = isHidden && !!onRestore;
  const showActionBar = showCompact || showOpen || showRestore;
  // Left gutter width (chevron + gap) so the stacked content aligns under the
  // headline in the wide layout; when narrow, everything runs full-bleed.
  const gutterIndent = "@xl:pl-6";

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(open) => {
        if (expandable && open !== expanded) onToggleExpand(item);
      }}
    >
      <Item
        variant={isHidden ? "muted" : "outline"}
        size="sm"
        className={cn(
          "@container flex-col items-stretch",
          "[content-visibility:auto] [contain-intrinsic-size:auto_104px]",
          selected && "ring-1 ring-ring",
        )}
        id={`attention-row-${item.id}`}
        data-attention-row
        data-attention-row-id={item.id}
        data-attention-source={item.sourceKind}
        data-attention-severity={item.severity}
      >
        <div className="flex items-start gap-2">
          {/* Expand affordance / spacer gutter — keeps headlines aligned across the list. */}
          {expandable ? (
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                role="button"
                variant="ghost"
                size="icon-xs"
                className="mt-0.5 shrink-0 text-muted-foreground"
                aria-label={expanded ? "Collapse decision" : "Expand decision"}
              >
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </Button>
            </CollapsibleTrigger>
          ) : (
            <span className="mt-0.5 hidden h-4 w-4 shrink-0 @xl:block" aria-hidden />
          )}

          {/* Content column: a single vertical stack that fills the full width on
            mobile (no competing right-hand controls) and reads top-to-bottom. */}
          <ItemContent className="gap-2">
            {/* Meta band: identity on the left, recency + overflow on the right.
              Not part of the clickable headline, so the menu never toggles it. */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Icon className="h-3.5 w-3.5" />
                  {meta.label}
                </span>
                {(item.severity === "critical" || item.severity === "high") && (
                  <Badge variant={item.severity === "critical" ? "destructive" : "secondary"}>
                    {item.severity === "critical" ? "Critical" : "High"}
                  </Badge>
                )}
                {item.relatedTask?.identifier && item.relatedTask.routeTarget ? (
                  <CompanyBoardLink
                    routeTarget={item.relatedTask.routeTarget}
                    className="font-mono text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {item.relatedTask.identifier}
                  </CompanyBoardLink>
                ) : null}
              </div>

              <ItemActions className="flex shrink-0 items-center gap-1" data-attention-menu="true">
                {isHidden && snoozedUntil ? (
                  <span
                    className="text-(length:--text-nano) text-muted-foreground"
                    title={`Reappears ${new Date(snoozedUntil).toLocaleString()}`}
                  >
                    Reappears {reappearLabel(snoozedUntil)}
                  </span>
                ) : (
                  <span className="text-(length:--text-nano) text-muted-foreground">
                    {relativeTime(item.activityAt)}
                  </span>
                )}
                {!isHidden && (dismissHandler || snoozeHandler || routeTarget) && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground"
                        aria-label="Row actions"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {snoozeHandler && <SnoozeSubmenu onSnooze={(iso) => snoozeHandler(item, iso)} />}
                      {dismissHandler && (
                        <DropdownMenuItem onClick={() => dismissHandler(item)}>
                          <X className="h-4 w-4" />
                          Dismiss
                        </DropdownMenuItem>
                      )}
                      {routeTarget && (
                        <>
                          {(dismissHandler || snoozeHandler) && <DropdownMenuSeparator />}
                          <DropdownMenuItem asChild>
                            <CompanyBoardLink routeTarget={routeTarget}>Open source</CompanyBoardLink>
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </ItemActions>
            </div>

            {/* Headline — the primary expand target for inline rows. Title now wraps
              to two lines instead of truncating to a sliver on narrow screens. */}
            {expandable ? (
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto min-w-0 w-full flex-col items-start whitespace-normal p-0 text-left hover:bg-transparent"
                  aria-label={expanded ? "Collapse decision" : "Expand decision"}
                >
                  <span
                    className="line-clamp-2 text-sm font-medium text-foreground"
                    title={item.subject.title ?? undefined}
                  >
                    {item.subject.title ?? meta.label}
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detailLine}</span>
                </Button>
              </CollapsibleTrigger>
            ) : (
              <div className="min-w-0 rounded-md">
                <span
                  className="line-clamp-2 text-sm font-medium text-foreground"
                  title={item.subject.title ?? undefined}
                >
                  {item.subject.title ?? meta.label}
                </span>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{detailLine}</p>
              </div>
            )}

            {/* Context row: project identity and evidence thumbnails move below the
              text so they never squeeze the headline on mobile. */}
            {(item.project || (hasImages && !expanded)) && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                {item.project && <ProjectMeta project={item.project} />}
                {hasImages && !expanded && <ThumbnailStack images={images} />}
              </div>
            )}

            {/* Action bar: full-width, thumb-reachable buttons on mobile;
              right-aligned dense pills on desktop. Sibling of the headline so
              taps never toggle expand. */}
            {showActionBar && (
              <div
                className={cn("flex flex-wrap items-center gap-2 @xl:justify-end", gutterIndent)}
                data-attention-actions="true"
              >
                {showCompact && <CompactDecisionActions item={item} companyId={companyId} />}

                {showOpen && routeTarget ? (
                  <Button asChild variant="outline" size="xs" className={cn(ACTION_BTN, "w-full @xl:w-auto")}>
                    <CompanyBoardLink routeTarget={routeTarget}>
                      Open
                      <ExternalLink className="h-3 w-3" data-icon="inline-end" />
                    </CompanyBoardLink>
                  </Button>
                ) : null}

                {showRestore && (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className={cn(ACTION_BTN, "w-full @xl:w-auto")}
                    onClick={() => onRestore(item)}
                  >
                    <RotateCcw className="h-3 w-3" data-icon="inline-start" />
                    Restore
                  </Button>
                )}
              </div>
            )}
          </ItemContent>
        </div>

        {(hasImages || inline) && (
          <CollapsibleContent className="space-y-3 border-t border-border/60 bg-muted/20 px-4 py-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200">
            {hasImages && <ExpandedImages images={images} taskRouteTarget={imageTaskTarget} />}
            {inline && <InlineResolver item={item} companyId={companyId} />}
          </CollapsibleContent>
        )}
      </Item>
    </Collapsible>
  );
});
