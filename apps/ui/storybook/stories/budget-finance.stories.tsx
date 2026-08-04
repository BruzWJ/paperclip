import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  canonicalizeMoneyAmount,
  type BudgetIncident,
  type BudgetPolicySummary,
} from "@paperclipai/shared";
import { BudgetIncidentCard } from "@/components/BudgetIncidentCard";
import { BudgetPolicyCard } from "@/components/BudgetPolicyCard";

const windowStart = new Date("2026-04-01T00:00:00.000Z");
const windowEnd = new Date("2026-05-01T00:00:00.000Z");

const policy: BudgetPolicySummary = {
  policyId: "policy-storybook",
  companyId: "company-storybook",
  budgetCurrency: "USD",
  scopeType: "project",
  scopeId: "project-storybook",
  scopeName: "Canonical runtime",
  windowKind: "calendar_month_utc",
  limitAmount: canonicalizeMoneyAmount("1200.000000001"),
  observedAmount: canonicalizeMoneyAmount("1031.000000001"),
  remainingAmount: canonicalizeMoneyAmount("169"),
  utilizationPercent: 85.91,
  warnPercent: 80,
  hardStopEnabled: true,
  notifyEnabled: true,
  isActive: true,
  status: "warning",
  paused: false,
  pauseReason: null,
  windowStart,
  windowEnd,
};

const incident: BudgetIncident = {
  id: "incident-storybook",
  companyId: "company-storybook",
  budgetCurrency: "USD",
  policyId: policy.policyId,
  scopeType: "agent",
  scopeId: "agent-storybook",
  scopeName: "Implementation agent",
  windowKind: "calendar_month_utc",
  windowStart,
  windowEnd,
  thresholdType: "hard",
  limitAmount: canonicalizeMoneyAmount("400"),
  observedAmount: canonicalizeMoneyAmount("432.000000001"),
  status: "open",
  approvalId: "approval-storybook",
  approvalStatus: "pending",
  resolvedAt: null,
  createdAt: new Date("2026-04-20T11:00:00.000Z"),
  updatedAt: new Date("2026-04-20T11:00:00.000Z"),
};

function CanonicalBudgetFinanceStory() {
  return (
    <div className="mx-auto grid max-w-5xl gap-6 p-6 lg:grid-cols-2">
      <BudgetPolicyCard summary={policy} onSave={() => undefined} />
      <BudgetIncidentCard
        incident={incident}
        onRaiseAndResume={() => undefined}
        onKeepPaused={() => undefined}
      />
    </div>
  );
}

const meta = {
  title: "Paperclip/Budget and finance/Canonical money",
  component: CanonicalBudgetFinanceStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CanonicalBudgetFinanceStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CanonicalMoney: Story = {};
