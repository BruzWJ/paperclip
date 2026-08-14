import { AttentionQueueRow } from "@/components/AttentionQueueRow";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { groupAttentionItems, planAttentionRenderRows } from "@/lib/attention";
import type { AttentionItem } from "@paperclipai/shared";
import { CheckCircle2, ChevronRight, Inbox } from "lucide-react";

const noopToggleExpand = () => {};

type AttentionGroup = ReturnType<typeof groupAttentionItems>[number];
type AttentionRenderPlan = ReturnType<typeof planAttentionRenderRows>;

export function DecisionQueue({
  companyId,
  hasAnything,
  activeItemCount,
  visibleCount,
  groups,
  collapsedGroupKeys,
  renderPlan,
  expandedId,
  selectedAttentionId,
  snoozedItems,
  snoozedOpen,
  dismissedItems,
  dismissedOpen,
  onToggleGroup,
  onToggleExpand,
  onDismiss,
  onSnooze,
  onRestore,
  onToggleSnoozed,
  onToggleDismissed,
}: {
  companyId: string;
  hasAnything: boolean;
  activeItemCount: number;
  visibleCount: number;
  groups: AttentionGroup[];
  collapsedGroupKeys: Set<string>;
  renderPlan: AttentionRenderPlan;
  expandedId: string | null;
  selectedAttentionId: string | null;
  snoozedItems: AttentionItem[];
  snoozedOpen: boolean;
  dismissedItems: AttentionItem[];
  dismissedOpen: boolean;
  onToggleGroup: (key: string) => void;
  onToggleExpand: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
  onSnooze: (item: AttentionItem, snoozedUntil: string) => void;
  onRestore: (item: AttentionItem) => void;
  onToggleSnoozed: () => void;
  onToggleDismissed: () => void;
}) {
  if (!hasAnything) return <DecisionZeroState />;
  return (
    <div className="space-y-4">
      {visibleCount === 0 ? (
        <DecisionCaughtUpNote filtered={activeItemCount > 0} />
      ) : (
        groups.map((group) => {
          const collapsed =
            group.label !== null && collapsedGroupKeys.has(group.key);
          return (
            <Collapsible
              key={group.key}
              open={!collapsed}
              onOpenChange={() => onToggleGroup(group.key)}
              asChild
            >
              <section className="space-y-2">
                {group.label !== null && (
                  <div className="flex items-center py-1.5 pl-1 pr-3">
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto min-w-0 gap-2 p-0 text-left"
                        aria-expanded={!collapsed}
                      >
                        <ChevronRight
                          className={cn(
                            "size-3.5 shrink-0 text-muted-foreground transition-transform",
                            !collapsed && "rotate-90",
                          )}
                        />
                        <span className="truncate text-sm font-semibold uppercase tracking-wide">
                          {group.label}
                        </span>
                      </Button>
                    </CollapsibleTrigger>
                    <div className="ml-auto">
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {group.items.length}
                      </span>
                    </div>
                  </div>
                )}
                <CollapsibleContent className="space-y-2">
                  {(renderPlan.groupRows.get(group.key) ?? []).map((item) => (
                    <AttentionQueueRow
                      key={item.id}
                      item={item}
                      companyId={companyId}
                      expanded={expandedId === item.id}
                      onToggleExpand={onToggleExpand}
                      onDismiss={onDismiss}
                      onSnooze={onSnooze}
                      selected={selectedAttentionId === item.id}
                    />
                  ))}
                </CollapsibleContent>
              </section>
            </Collapsible>
          );
        })
      )}
      <HiddenDecisionCurtain
        label="Snoozed"
        items={snoozedItems}
        rows={renderPlan.snoozedRows}
        open={snoozedOpen}
        companyId={companyId}
        onToggle={onToggleSnoozed}
        onDismiss={onDismiss}
        onRestore={onRestore}
      />
      <HiddenDecisionCurtain
        label="Dismissed"
        items={dismissedItems}
        rows={renderPlan.dismissedRows}
        open={dismissedOpen}
        companyId={companyId}
        onToggle={onToggleDismissed}
        onDismiss={onDismiss}
        onRestore={onRestore}
      />
    </div>
  );
}

function HiddenDecisionCurtain({
  label,
  items,
  rows,
  open,
  companyId,
  onToggle,
  onDismiss,
  onRestore,
}: {
  label: string;
  items: AttentionItem[];
  rows: AttentionItem[];
  open: boolean;
  companyId: string;
  onToggle: () => void;
  onDismiss: (item: AttentionItem) => void;
  onRestore: (item: AttentionItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={onToggle} asChild>
      <section className="space-y-2">
        <div className="flex items-center py-1.5 pl-1 pr-3 text-muted-foreground">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-auto min-w-0 gap-2 p-0 text-left"
              aria-expanded={open}
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform",
                  open && "rotate-90",
                )}
              />
              <span className="truncate text-sm font-semibold uppercase tracking-wide">
                {label} ({items.length})
              </span>
            </Button>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="space-y-2">
          {rows.map((item) => (
            <AttentionQueueRow
              key={item.id}
              item={item}
              companyId={companyId}
              variant="hidden"
              expanded={false}
              onToggleExpand={noopToggleExpand}
              onDismiss={onDismiss}
              onRestore={onRestore}
            />
          ))}
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function DecisionCaughtUpNote({ filtered }: { filtered: boolean }) {
  return (
    <Empty className="border py-10 md:p-10">
      <EmptyHeader>
        <EmptyTitle className="text-sm">
          {filtered
            ? "No decisions match your filters."
            : "You're all caught up."}
        </EmptyTitle>
        {filtered ? (
          <EmptyDescription>
            Adjust or clear the filters to see the rest.
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
    </Empty>
  );
}

function DecisionZeroState() {
  return (
    <Empty className="border py-20">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CheckCircle2 />
        </EmptyMedia>
        <EmptyTitle>You're all caught up</EmptyTitle>
        <EmptyDescription className="flex items-center gap-1.5">
          <Inbox />
          Nothing needs a decision from you right now.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
