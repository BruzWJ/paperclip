import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  InterruptOwnerChangeConfirm,
  OwnerChip,
  OwnerRunningBanner,
  PauseAffectsSummaryView,
  type OwnerChipResolvers,
} from "@/routes/_authenticated/$companyId/tasks/$taskNumber/-owner-transition/-OwnerTransitionViews";
import { computePauseAffectsSummary, describeOwnerChangeInterrupt } from "@/lib/owner-transition";

const resolvers: OwnerChipResolvers = {
  agentMap: new Map([
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", { name: "ClaudeCoder", icon: null }],
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", { name: "QA", icon: null }],
  ]),
  resolveUserLabel: (id) => (id === "a7000000-0000-4000-8000-000000000002" ? "Riley Board" : null),
  currentUserId: "a7000000-0000-4000-8000-000000000002",
};

const meta: Meta = {
  title: "Surfaces/Owner Transition",
};
export default meta;
type Story = StoryObj;

export const CanonicalStates: Story = {
  render: () => {
    const copy = describeOwnerChangeInterrupt({ runningAgentName: "ClaudeCoder" });
    return (
      <div className="flex max-w-xl flex-col gap-4 p-4">
        <div className="flex items-center gap-2">
          <OwnerChip
            owner={{
              ownerKind: "agent",
              ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6",
              ownerUserId: null,
            }}
            resolvers={resolvers}
          />
          <OwnerChip
            owner={{
              ownerKind: "user",
              ownerAgentId: null,
              ownerUserId: "a7000000-0000-4000-8000-000000000002",
            }}
            resolvers={resolvers}
          />
          <OwnerChip
            owner={{ ownerKind: "board", ownerAgentId: null, ownerUserId: null }}
            resolvers={resolvers}
          />
        </div>
        <OwnerRunningBanner copy={copy} />
        <InterruptOwnerChangeConfirm
          copy={copy}
          to={{ ownerKind: "agent", ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", ownerUserId: null }}
          resolvers={resolvers}
          onConfirm={() => {}}
          onCancel={() => {}}
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
