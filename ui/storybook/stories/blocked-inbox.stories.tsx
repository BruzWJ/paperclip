import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue, IssueBlockedInboxAttention } from "@paperclipai/shared";
import { BlockedInboxView } from "@/components/BlockedInboxView";
import { BlockedReasonChip } from "@/components/BlockedReasonChip";
import { defaultIssueFilterState } from "@/lib/issue-filters";
import { queryKeys } from "@/lib/queryKeys";
import { storybookIssues } from "../fixtures/paperclipData";

const companyId = "company-storybook";
const blockedViewDefaults = {
  groupBy: "none" as const,
  sortBy: "most_recent" as const,
  issueFilters: defaultIssueFilterState,
  currentUserId: "user-1",
  liveIssueIds: new Set<string>(),
  workspaceFilterContext: {},
  showStatusColumn: true,
  showIdentifierColumn: true,
  showUpdatedColumn: true,
};

function attention(
  overrides: Partial<IssueBlockedInboxAttention> = {},
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "medium",
    stoppedSinceAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    owner: { type: "agent", agentId: null, userId: null, label: "ClaudeCoder" },
    action: { label: "Resolve PAP-12", detail: null },
    sourceIssue: null,
    leafIssue: null,
    approvalId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

const baseIssue = storybookIssues[0]!;

const fixtureIssues: Issue[] = [
  {
    ...baseIssue,
    id: "issue-decision-1",
    identifier: "PAP-401",
    title: "Approve plan: rewrite onboarding flow",
    boardPresentationStatus: "in_review",
    blockedInboxAttention: attention({
      reason: "pending_board_decision",
      state: "awaiting_decision",
      severity: "medium",
      stoppedSinceAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      owner: { type: "board", agentId: null, userId: null, label: "Board" },
      action: { label: "Accept or reject", detail: null },
    }),
  },
  {
    ...baseIssue,
    id: "issue-stalled-critical",
    identifier: "PAP-410",
    title: "Ship invoice export — blocker is stalled",
    boardPresentationStatus: "blocked",
    blockedInboxAttention: attention({
      reason: "blocked_chain_stalled",
      state: "needs_attention",
      severity: "critical",
      stoppedSinceAt: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString(),
      owner: {
        type: "agent",
        agentId: null,
        userId: null,
        label: "CodexCoder",
      },
      action: { label: "Resolve PAP-411", detail: null },
    }),
  },
  {
    ...baseIssue,
    id: "issue-stalled-high",
    identifier: "PAP-412",
    title: "Run nightly maintenance",
    boardPresentationStatus: "blocked",
    blockedInboxAttention: attention({
      reason: "blocked_chain_stalled",
      severity: "high",
      stoppedSinceAt: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
      owner: { type: "agent", agentId: null, userId: null, label: "QA" },
      action: { label: "Resolve PAP-413", detail: null },
    }),
  },
  {
    ...baseIssue,
    id: "issue-external",
    identifier: "PAP-440",
    title: "Awaiting upstream provider response",
    boardPresentationStatus: "blocked",
    blockedInboxAttention: attention({
      reason: "external_owner_action",
      state: "external_wait",
      severity: "low",
      stoppedSinceAt: new Date(
        Date.now() - 3 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      owner: { type: "external", agentId: null, userId: null, label: "Stripe" },
      action: { label: "Awaiting Stripe", detail: null },
    }),
  },
];

function PrimeBlockedFixtures({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  useMemo(() => {
    queryClient.setQueryData(
      queryKeys.issues.listBlockedAttention(companyId),
      fixtureIssues,
    );
  }, [queryClient]);
  return <>{children}</>;
}

function BlockedTabSurface({ search = "" }: { search?: string }) {
  return (
    <PrimeBlockedFixtures>
      <div className="space-y-3">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Inbox / Blocked tab — desktop layout
        </div>
        <div className="rounded-lg border border-border bg-background p-4">
          <BlockedInboxView
            {...blockedViewDefaults}
            companyId={companyId}
            searchQuery={search}
            agentNameById={new Map()}
            issueLinkState={null}
            subtreeLiveCounts={new Map()}
          />
        </div>
      </div>
    </PrimeBlockedFixtures>
  );
}

function BlockedTabSurfaceMobile() {
  return (
    <div className="mx-auto max-w-[390px] space-y-3">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        Inbox / Blocked tab — 390px mobile width
      </div>
      <div className="rounded-lg border border-border bg-background p-2">
        <BlockedTabSurface />
      </div>
    </div>
  );
}

function BlockedReasonChipsCatalog() {
  return (
    <div className="grid gap-3 p-6 sm:grid-cols-2">
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Needs decision · medium
        </div>
        <BlockedReasonChip reason="pending_board_decision" severity="medium" />
      </div>
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Blocked chain stalled · critical
        </div>
        <BlockedReasonChip reason="blocked_chain_stalled" severity="critical" />
      </div>
      <div className="space-y-2">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          External wait · low (no severity dot)
        </div>
        <BlockedReasonChip reason="external_owner_action" severity="low" />
      </div>
    </div>
  );
}

function BlockedTabEmptyState() {
  return (
    <div className="rounded-lg border border-border bg-background p-4">
      <BlockedInboxView
        {...blockedViewDefaults}
        companyId="company-empty"
        searchQuery=""
        agentNameById={new Map()}
        issueLinkState={null}
        subtreeLiveCounts={new Map()}
      />
    </div>
  );
}

const meta = {
  title: "Product/Inbox/Blocked tab",
  component: BlockedTabSurface,
  parameters: {
    docs: {
      description: {
        component:
          "Stopped-work triage Inbox tab. Rows group by reason variant and sort by severity → stoppedSinceAt. The reason chip + owner + action combo sits next to the issue title. No quick archive on this tab.",
      },
    },
  },
} satisfies Meta<typeof BlockedTabSurface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const DesktopLoaded: Story = {
  render: () => <BlockedTabSurface />,
};

export const DesktopWithSearch: Story = {
  render: () => <BlockedTabSurface search="parked" />,
};

export const MobileLayout: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => <BlockedTabSurfaceMobile />,
};

export const ReasonChipCatalog: Story = {
  render: () => <BlockedReasonChipsCatalog />,
};

export const EmptyState: Story = {
  render: () => <BlockedTabEmptyState />,
};
