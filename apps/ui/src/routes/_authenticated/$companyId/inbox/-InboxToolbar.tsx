import { TaskColumnPicker } from "@/routes/_authenticated/$companyId/-tasks-list/-TaskColumns";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BLOCKED_GROUP_OPTIONS, BLOCKED_SORT_OPTIONS } from "@/lib/blockedInbox";
import { DEFAULT_INBOX_TASK_COLUMNS, type InboxApprovalFilter, type InboxCategoryFilter } from "@/lib/inbox";
import { shouldBlurPageSearchOnEnter, shouldBlurPageSearchOnEscape } from "@/lib/keyboardShortcuts";
import { cn } from "@/lib/utils";
import { ArrowUpDown, Check, Layers, ListTree, Search } from "lucide-react";
import { useInboxPage } from "./-InboxPageContext";

const INBOX_GROUP_OPTIONS = [
  ["none", "None"],
  ["type", "Type"],
  ["owner", "Owner"],
  ["project", "Project"],
] as const;

function InboxSearch({ className }: { className: string }) {
  const { searchQuery, setSearchQuery } = useInboxPage();
  return (
    <InputGroup className={className}>
      <InputGroupAddon>
        <Search  data-icon="inline-start"/>
      </InputGroupAddon>
      <InputGroupInput
        aria-label="Search inbox"
        type="search"
        placeholder="Search inbox…"
        value={searchQuery}
        onChange={(event) => setSearchQuery(event.target.value)}
        onKeyDown={(event) => {
          const shortcut = {
            key: event.key,
            isComposing: event.nativeEvent.isComposing,
          };
          if (
            shouldBlurPageSearchOnEnter(shortcut) ||
            shouldBlurPageSearchOnEscape({ ...shortcut, currentValue: event.currentTarget.value })
          ) {
            event.currentTarget.blur();
          }
        }}
        className="text-xs"
        data-page-search-target="true"
      />
    </InputGroup>
  );
}

function InboxGroupPicker<T extends string>({
  onValueChange,
  options,
  value,
}: {
  onValueChange: (value: T) => void;
  options: readonly (readonly [T, string])[];
  value: T;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className={cn("h-8 w-8 shrink-0", value !== "none" && "bg-accent")}
          title="Group"
        >
          <Layers className="h-3.5 w-3.5"  data-icon="inline-start"/>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-44 p-0">
        <div className="space-y-0.5 p-2">
          {options.map(([optionValue, label]) => (
            <Button
              key={optionValue}
              variant={value === optionValue ? "secondary" : "ghost"}
              size="sm"
              className="w-full justify-between"
              onClick={() => onValueChange(optionValue)}
            >
              <span>{label}</span>
              {value === optionValue ? <Check className="h-3.5 w-3.5"  data-icon="inline-start"/> : null}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function InboxToolbar() {
  const {
    tab,
    navigate,
    companyId,
    groupBy,
    blockedGroupBy,
    setBlockedGroupBy,
    blockedSortBy,
    setBlockedSortBy,
    visibleTaskColumnSet,
    availableTaskColumns,
    nestingEnabled,
    toggleNesting,
    setTaskColumns,
    toggleTaskColumn,
    updateGroupBy,
    showMarkAllReadConfirm,
    setShowMarkAllReadConfirm,
    markAllReadMutation,
    unreadTaskIds,
    canMarkAllRead,
    showGeneralTaskToolbarControls,
    taskFiltersPopover,
  } = useInboxPage();
  const taskColumnPicker = (
    <TaskColumnPicker
      availableColumns={availableTaskColumns}
      visibleColumnSet={visibleTaskColumnSet}
      onToggleColumn={toggleTaskColumn}
      onResetColumns={() => setTaskColumns(DEFAULT_INBOX_TASK_COLUMNS)}
      title="Choose which inbox columns stay visible"
      iconOnly
    />
  );
  return (
    <>
      {markAllReadMutation.isPending ? (
        <p className="sr-only" role="status">
          Marking all visible inbox items as read.
        </p>
      ) : null}
      <div className="space-y-2">
        {/* Search — full-width row on mobile, inline on desktop */}
        <div className="sm:hidden">
          <InboxSearch className="h-8 w-full" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (value === "mine") {
                void navigate({
                  to: "/$companyId/inbox",
                  params: { companyId },
                });
              } else if (value === "recent") {
                void navigate({
                  to: "/$companyId/inbox/recent",
                  params: { companyId },
                });
              } else if (value === "unread") {
                void navigate({
                  to: "/$companyId/inbox/unread",
                  params: { companyId },
                });
              } else if (value === "blocked") {
                void navigate({
                  to: "/$companyId/inbox/blocked",
                  params: { companyId },
                });
              } else if (value === "all") {
                void navigate({
                  to: "/$companyId/inbox/all",
                  params: { companyId },
                });
              }
            }}
          >
            <TabsList variant="line">
              <TabsTrigger value="mine">Mine</TabsTrigger>
              <TabsTrigger value="recent">Recent</TabsTrigger>
              <TabsTrigger value="unread">Unread</TabsTrigger>
              <TabsTrigger value="blocked">Blocked</TabsTrigger>
              <TabsTrigger value="all">All</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-2">
            <div className="hidden sm:block">
              <InboxSearch className="h-8 w-(--sz-220px)" />
            </div>
            {tab === "blocked" ? (
              <>
                {taskFiltersPopover}
                <InboxGroupPicker
                  value={blockedGroupBy}
                  options={BLOCKED_GROUP_OPTIONS}
                  onValueChange={setBlockedGroupBy}
                />
                {taskColumnPicker}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      title="Sort"
                    >
                      <ArrowUpDown className="h-3.5 w-3.5"  data-icon="inline-start"/>
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-48 p-0">
                    <div className="space-y-0.5 p-2">
                      {BLOCKED_SORT_OPTIONS.map(([value, label]) => (
                        <Button
                          key={value}
                          variant={blockedSortBy === value ? "secondary" : "ghost"}
                          size="sm"
                          className="w-full justify-between"
                          onClick={() => setBlockedSortBy(value)}
                        >
                          <span>{label}</span>
                          {blockedSortBy === value ? <Check className="h-3.5 w-3.5"  data-icon="inline-start"/> : null}
                        </Button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
              </>
            ) : showGeneralTaskToolbarControls ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className={cn("hidden h-8 w-8 shrink-0 sm:inline-flex", nestingEnabled && "bg-accent")}
                  onClick={toggleNesting}
                  title={nestingEnabled ? "Disable parent-child nesting" : "Enable parent-child nesting"}
                >
                  <ListTree className="h-3.5 w-3.5"  data-icon="inline-start"/>
                </Button>
                {taskFiltersPopover}
                <InboxGroupPicker
                  value={groupBy}
                  options={INBOX_GROUP_OPTIONS}
                  onValueChange={updateGroupBy}
                />
                {taskColumnPicker}
                {canMarkAllRead && (
                  <ConfirmActionDialog
                    open={showMarkAllReadConfirm}
                    onOpenChange={setShowMarkAllReadConfirm}
                    triggerAsChild
                    trigger={
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0"
                        disabled={markAllReadMutation.isPending}
                      >
                        {markAllReadMutation.isPending ? "Marking…" : "Mark all as read"}
                      </Button>
                    }
                    title="Mark all as read?"
                    description={
                      <>
                        This will mark {unreadTaskIds.length} unread{" "}
                        {unreadTaskIds.length === 1 ? "item" : "items"} as read.
                      </>
                    }
                    confirmLabel="Mark all as read"
                    pendingLabel="Marking…"
                    pending={markAllReadMutation.isPending}
                    onConfirm={() => markAllReadMutation.mutateAsync(unreadTaskIds)}
                  />
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

export function InboxAllFilters() {
  const {
    tab,
    allCategoryFilter,
    allApprovalFilter,
    showApprovalsCategory,
    updateAllCategoryFilter,
    updateAllApprovalFilter,
  } = useInboxPage();
  if (tab !== "all") return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={allCategoryFilter}
        onValueChange={(value) => updateAllCategoryFilter(value as InboxCategoryFilter)}
      >
        <SelectTrigger aria-label="Filter inbox by category">
          <SelectValue placeholder="Category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="everything">All categories</SelectItem>
          <SelectItem value="tasks_i_touched">My recent tasks</SelectItem>
          <SelectItem value="join_requests">Join requests</SelectItem>
          <SelectItem value="approvals">Approvals</SelectItem>
          <SelectItem value="failed_runs">Failed runs</SelectItem>
          <SelectItem value="alerts">Alerts</SelectItem>
        </SelectContent>
      </Select>

      {showApprovalsCategory ? (
        <Select
          value={allApprovalFilter}
          onValueChange={(value) => updateAllApprovalFilter(value as InboxApprovalFilter)}
        >
          <SelectTrigger aria-label="Filter inbox by approval status">
            <SelectValue placeholder="Approval status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All approval statuses</SelectItem>
            <SelectItem value="actionable">Needs action</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
