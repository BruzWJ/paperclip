import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Issue, IssueWatchdog } from "@paperclipai/shared";
import { IssueProperties } from "@/components/IssueProperties";
import {
  storybookExecutionWorkspaces,
  storybookIssueDocuments,
  storybookIssues,
} from "../fixtures/paperclipData";

const issueDocumentSummaries = storybookIssueDocuments.map(({ body: _body, ...summary }) => summary);

const baseIssue: Issue = {
  ...storybookIssues[0]!,
  planDocument: storybookIssueDocuments.find((document) => document.key === "plan") ?? null,
  documentSummaries: issueDocumentSummaries,
  currentExecutionWorkspace: storybookExecutionWorkspaces[0]!,
  watchdog: null,
};

function safeguard(overrides: Partial<IssueWatchdog> = {}): IssueWatchdog {
  return {
    id: "watchdog-1",
    companyId: baseIssue.companyId,
    issueId: baseIssue.id,
    status: "active",
    lastObservedFingerprint: null,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: new Date(Date.now() - 60 * 60_000),
    updatedAt: new Date(Date.now() - 60 * 60_000),
    ...overrides,
  };
}

function SystemSafeguardSurfaces() {
  const disabledIssue: Issue = { ...baseIssue, watchdog: null };
  const enabledIssue: Issue = { ...baseIssue, watchdog: safeguard() };
  const triggeredIssue: Issue = {
    ...baseIssue,
    watchdog: safeguard({
      lastObservedFingerprint: "issue_watchdog_stop:example",
      lastTriggeredAt: new Date(Date.now() - 10 * 60_000),
      triggerCount: 2,
    }),
  };

  return (
    <div className="space-y-8 p-6">
      <div className="grid gap-6 lg:grid-cols-3">
        {[
          ["Disabled", disabledIssue],
          ["Enabled", enabledIssue],
          ["Triggered twice", triggeredIssue],
        ].map(([label, issue]) => (
          <section key={label as string} className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">
              System safeguard — {label as string}
            </div>
            <div className="rounded-lg border border-border bg-background/70 p-4">
              <IssueProperties issue={issue as Issue} onUpdate={() => undefined} inline />
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

const meta = {
  title: "Product/System safeguard surfaces",
  component: SystemSafeguardSurfaces,
  parameters: {
    docs: {
      description: {
        component:
          "Shows the board-owned enable/disable safeguard. The system classifies the watched subtree and nudges the current owner; there is no selected agent, custom prompt, or generated review task.",
      },
    },
  },
} satisfies Meta<typeof SystemSafeguardSurfaces>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SystemSafeguards: Story = {};
