import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ComposerMentionCoach,
  ComposerOwnerPreviewRow,
  InterruptOwnerChangeConfirm,
  OwnerChip,
  OwnerRunningBanner,
  OwnerDispatchRow,
  PauseAffectsSummaryView,
  RunStatusBadge,
  type OwnerChipResolvers,
} from "@/components/owner-transition/OwnerTransitionViews";
import {
  computeComposerOwnerPreview,
  computePauseAffectsSummary,
  describeOwnerChangeInterrupt,
} from "@/lib/owner-transition";

const resolvers: OwnerChipResolvers = {
  agentMap: new Map([
    ["agent-coder", { name: "ClaudeCoder", icon: null }],
    ["agent-qa", { name: "QA", icon: null }],
  ]),
  resolveUserLabel: (id) => (id === "user-board" ? "Riley Board" : null),
  currentUserId: "user-board",
};

const meta: Meta = {
  title: "Surfaces/Owner Transition",
};
export default meta;
type Story = StoryObj;

export const CanonicalStates: Story = {
  render: () => {
    const copy = describeOwnerChangeInterrupt({ runningAgentName: "ClaudeCoder" });
    const preview = computeComposerOwnerPreview({
      ownerTarget: "agent:agent-qa",
      currentOwnerValue: "agent:agent-coder",
      hasActiveRun: true,
      bodyHasAgentMention: false,
    });
    return (
      <div className="flex max-w-xl flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <OwnerChip
            owner={{ ownerKind: "agent", ownerAgentId: "agent-coder", ownerUserId: null }}
            resolvers={resolvers}
          />
          <OwnerChip
            owner={{ ownerKind: "user", ownerAgentId: null, ownerUserId: "user-board" }}
            resolvers={resolvers}
          />
          <OwnerChip
            owner={{ ownerKind: "board", ownerAgentId: null, ownerUserId: null }}
            resolvers={resolvers}
          />
        </div>
        <RunStatusBadge status="cancelled" operatorInterrupted />
        <OwnerDispatchRow
          to={{ ownerKind: "agent", ownerAgentId: "agent-qa", ownerUserId: null }}
          resolvers={resolvers}
          interruptedRunAttached
        />
        <ComposerOwnerPreviewRow preview={preview} resolvers={resolvers} />
        <OwnerRunningBanner copy={copy} />
        <InterruptOwnerChangeConfirm
          copy={copy}
          to={{ ownerKind: "agent", ownerAgentId: "agent-qa", ownerUserId: null }}
          resolvers={resolvers}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
        <ComposerMentionCoach
          candidate={{ agentId: "agent-qa", matchedText: "QA" }}
          agentDisplayName="QA"
          onInsert={() => {}}
          onDismiss={() => {}}
        />
        <PauseAffectsSummaryView
          summary={computePauseAffectsSummary([
            { activeRun: { status: "running" } },
            { activeRun: { status: "queued" } },
            { activeRun: null },
          ])}
        />
      </div>
    );
  },
};
