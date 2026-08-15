import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  canonicalizeMoneyAmount,
  type BudgetIncident,
  type BudgetPolicySummary,
} from "@paperclipai/shared";
import { BudgetIncidentCard } from "@/routes/_authenticated/$companyId/costs/-BudgetIncidentCard";
import { BudgetPolicyCard } from "@/routes/_authenticated/$companyId/-BudgetPolicyCard";

const windowStart = new Date("2026-04-01T00:00:00.000Z");
const windowEnd = new Date("2026-05-01T00:00:00.000Z");

const policy: BudgetPolicySummary = {
  policyId: "b3000000-0000-4000-8000-000000000001",
  companyId: "11111111-1111-4111-8111-111111111111",
  budgetCurrency: "USD",
  scopeType: "project",
  scopeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6",
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
  id: "b4000000-0000-4000-8000-000000000001",
  companyId: "11111111-1111-4111-8111-111111111111",
  budgetCurrency: "USD",
  policyId: policy.policyId,
  scopeType: "agent",
  scopeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7",
  scopeName: "Implementation agent",
  windowKind: "calendar_month_utc",
  windowStart,
  windowEnd,
  thresholdType: "hard",
  limitAmount: canonicalizeMoneyAmount("400"),
  observedAmount: canonicalizeMoneyAmount("432.000000001"),
  status: "open",
  approvalId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4",
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
