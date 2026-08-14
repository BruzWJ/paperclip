import {
  canonicalizeMoneyAmount,
  type Agent,
  type AuthSession,
  type Company,
  type CompanySecretProviderConfig,
  type CompanySecretUsageBinding,
  type DashboardSummary,
  type Goal,
  type Project,
  type SecretAccessEvent,
  type SecretProviderConfigDiscoveryPreviewResult,
  type SecretProviderDescriptor,
  type TaskLabel,
} from "@paperclipai/shared";

export const now = new Date("2026-04-20T12:00:00.000Z");

export const recent = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);

export const storybookAuthSession: AuthSession = {
  session: {
    id: "storybook-session",
    userId: "a7000000-0000-4000-8000-000000000002",
  },
  user: {
    id: "a7000000-0000-4000-8000-000000000002",
    email: "board@paperclip.local",
    name: "Board Operator",
    image: null,
  },
};

export const storybookSecretProviders: SecretProviderDescriptor[] = [
  {
    id: "local_encrypted",
    label: "Local encrypted",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: false,
    configured: true,
  },
  {
    id: "aws_secrets_manager",
    label: "AWS Secrets Manager",
    requiresExternalRef: true,
    supportsManagedValues: false,
    supportsExternalReferences: true,
    configured: false,
  },
  {
    id: "gcp_secret_manager",
    label: "Google Cloud Secret Manager",
    requiresExternalRef: true,
    supportsManagedValues: false,
    supportsExternalReferences: true,
    configured: false,
  },
  {
    id: "vault",
    label: "HashiCorp Vault",
    requiresExternalRef: true,
    supportsManagedValues: false,
    supportsExternalReferences: true,
    configured: false,
  },
];

export const storybookSecretProviderHealth = {
  providers: [
    {
      provider: "local_encrypted" as const,
      status: "ok" as const,
      message: "Local encrypted secrets are available.",
    },
  ],
};

export const storybookSecretProviderConfigs: CompanySecretProviderConfig[] = [];

export const storybookSecretBindings: CompanySecretUsageBinding[] = [];

export const storybookSecretAccessEvents: SecretAccessEvent[] = [];

export const storybookSecretProviderDiscoveryPreview: SecretProviderConfigDiscoveryPreviewResult = {
  provider: "aws_secrets_manager",
  nextToken: null,
  sampledSecretCount: 0,
  skippedForeignPaperclipSampleCount: 0,
  candidates: [],
  warnings: [],
};

export const storybookDashboardSummary: DashboardSummary = {
  companyId: "11111111-1111-4111-8111-111111111111",
  agents: { idle: 2, paused: 0, error: 0 },
  tasks: { open: 4, inProgress: 2, blocked: 1, done: 3 },
  costs: {
    budgetCurrency: "USD",
    monthKnownSpendAmount: canonicalizeMoneyAmount("675"),
    monthBudgetAmount: canonicalizeMoneyAmount("2500"),
    monthRemainingAmount: canonicalizeMoneyAmount("1825"),
    monthUtilizationPercent: 27,
    unpricedPromptCount: 0,
  },
  pendingApprovals: 2,
  budgets: {
    activeIncidents: 1,
    pendingApprovals: 1,
    pausedAgents: 0,
    pausedProjects: 0,
  },
  runActivity: [],
};

export const storybookCompanies: Company[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Paperclip Storybook",
    description: "Fixture company for isolated UI review.",
    status: "active",
    pauseReason: null,
    pausedAt: null,
    taskPrefix: "PAP",
    taskCounter: 1641,
    budgetCurrency: "USD",
    budgetMonthlyAmount: canonicalizeMoneyAmount("2500"),
    knownSpendAmount: canonicalizeMoneyAmount("675"),
    attachmentMaxBytes: 10 * 1024 * 1024,
    defaultResponsibleUserId: "a7000000-0000-4000-8000-000000000002",
    requireBoardApprovalForNewAgents: true,
    brandColor: "#0f766e",
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-04-01T09:00:00.000Z"),
    updatedAt: now,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Research Bureau",
    description: "A second active company for rail and switcher state coverage.",
    status: "active",
    pauseReason: null,
    pausedAt: null,
    taskPrefix: "RES",
    taskCounter: 88,
    budgetCurrency: "EUR",
    budgetMonthlyAmount: canonicalizeMoneyAmount("1800"),
    knownSpendAmount: canonicalizeMoneyAmount("395"),
    attachmentMaxBytes: 10 * 1024 * 1024,
    defaultResponsibleUserId: "a7000000-0000-4000-8000-000000000002",
    requireBoardApprovalForNewAgents: false,
    brandColor: "#4f46e5",
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-04-03T09:00:00.000Z"),
    updatedAt: recent(10),
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Launch Ops",
    description: "Paused company for inactive switcher treatment.",
    status: "paused",
    pauseReason: "manual",
    pausedAt: recent(240),
    taskPrefix: "OPS",
    taskCounter: 204,
    budgetCurrency: "USD",
    budgetMonthlyAmount: canonicalizeMoneyAmount("900"),
    knownSpendAmount: canonicalizeMoneyAmount("912"),
    attachmentMaxBytes: 10 * 1024 * 1024,
    defaultResponsibleUserId: "a7000000-0000-4000-8000-000000000002",
    requireBoardApprovalForNewAgents: true,
    brandColor: "#c2410c",
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date("2026-04-05T09:00:00.000Z"),
    updatedAt: recent(240),
  },
];

export const storybookAgents: Agent[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "CodexCoder",
    title: "Senior Product Engineer",
    icon: "code",
    status: "idle",
    reportsTo: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    capabilities: "Ships full-stack Paperclip product tasks, Storybook coverage, and verification.",
    currentAdapterConfigRevisionId: null,
    budgetMonthlyAmount: canonicalizeMoneyAmount("1250"),
    knownSpendAmount: canonicalizeMoneyAmount("432"),
    pauseReason: null,
    pausedAt: null,
    instruction: null,
    createdAt: recent(12_000),
    updatedAt: recent(3),
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "QAChecker",
    title: "QA Engineer",
    icon: "shield",
    status: "idle",
    reportsTo: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    capabilities: "Validates browser flows, acceptance criteria, and release smoke tests.",
    currentAdapterConfigRevisionId: null,
    budgetMonthlyAmount: canonicalizeMoneyAmount("800"),
    knownSpendAmount: canonicalizeMoneyAmount("189"),
    pauseReason: null,
    pausedAt: null,
    instruction: null,
    createdAt: recent(11_000),
    updatedAt: recent(24),
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "CTO",
    title: "CTO",
    icon: "crown",
    status: "idle",
    reportsTo: null,
    capabilities: "Reviews architecture, quality gates, and engineering priority tradeoffs.",
    currentAdapterConfigRevisionId: null,
    budgetMonthlyAmount: canonicalizeMoneyAmount("2000"),
    knownSpendAmount: canonicalizeMoneyAmount("540"),
    pauseReason: null,
    pausedAt: null,
    instruction: null,
    createdAt: recent(14_000),
    updatedAt: recent(41),
  },
];

export const storybookAgentMap = new Map(storybookAgents.map((agent) => [agent.id, agent]));

export const storybookTaskLabels: TaskLabel[] = [
  {
    id: "a1000000-0000-4000-8000-000000000001",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "UI",
    color: "#0f766e",
    createdAt: recent(20_000),
    updatedAt: recent(20_000),
  },
  {
    id: "a1000000-0000-4000-8000-000000000002",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "Design system",
    color: "#f59e0b",
    createdAt: recent(20_000),
    updatedAt: recent(20_000),
  },
  {
    id: "a1000000-0000-4000-8000-000000000003",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "API",
    color: "#2563eb",
    createdAt: recent(18_000),
    updatedAt: recent(18_000),
  },
  {
    id: "a1000000-0000-4000-8000-000000000004",
    companyId: "11111111-1111-4111-8111-111111111111",
    name: "Risk",
    color: "#dc2626",
    createdAt: recent(16_000),
    updatedAt: recent(16_000),
  },
];

const storybookTaskLabelMap = new Map(storybookTaskLabels.map((label) => [label.id, label]));

export function labelsFor(ids: string[]) {
  return ids.map((id) => storybookTaskLabelMap.get(id)).filter((label): label is TaskLabel => Boolean(label));
}

export const storybookGoals: Goal[] = [
  {
    id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    companyId: "11111111-1111-4111-8111-111111111111",
    title: "Build Paperclip",
    description: "Make Paperclip the control plane operators trust for autonomous AI companies.",
    level: "company",
    status: "active",
    parentId: null,
    ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    createdAt: recent(30_000),
    updatedAt: recent(8),
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
    companyId: "11111111-1111-4111-8111-111111111111",
    title: "Tighten board operator visibility",
    description:
      "Every project, goal, and workspace surface should reveal ownership, progress, and runtime state at a glance.",
    level: "team",
    status: "active",
    parentId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    createdAt: recent(19_000),
    updatedAt: recent(18),
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
    companyId: "11111111-1111-4111-8111-111111111111",
    title: "Stabilize agent runtime loops",
    description: "Keep local development flows predictable while preserving operator control.",
    level: "team",
    status: "planned",
    parentId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
    ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    createdAt: recent(17_500),
    updatedAt: recent(60),
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc4",
    companyId: "11111111-1111-4111-8111-111111111111",
    title: "Complete Storybook review coverage",
    description: "Capture dense board UI states in fixture-backed stories before release review.",
    level: "task",
    status: "active",
    parentId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
    ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    createdAt: recent(9_000),
    updatedAt: recent(3),
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc5",
    companyId: "11111111-1111-4111-8111-111111111111",
    title: "Enforce spend guardrails",
    description: "Budget hard stops should be visible before they surprise operators.",
    level: "agent",
    status: "achieved",
    parentId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
    ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    createdAt: recent(12_000),
    updatedAt: recent(120),
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc6",
    companyId: "11111111-1111-4111-8111-111111111111",
    title: "Retire old import wizard",
    description: "Retired import wizard work is retained for audit records.",
    level: "task",
    status: "cancelled",
    parentId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
    ownerAgentId: null,
    createdAt: recent(24_000),
    updatedAt: recent(2_500),
  },
];

function createProject(overrides: Partial<Project> = {}): Project {
  const id = overrides.id ?? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  return {
    id,
    companyId: "11111111-1111-4111-8111-111111111111",
    goalIds: ["cccccccc-cccc-4ccc-8ccc-ccccccccccc1", "cccccccc-cccc-4ccc-8ccc-ccccccccccc2"],
    goals: storybookGoals
      .filter(
        (goal) =>
          goal.id === "cccccccc-cccc-4ccc-8ccc-ccccccccccc1" ||
          goal.id === "cccccccc-cccc-4ccc-8ccc-ccccccccccc2",
      )
      .map(({ id, title }) => ({ id, title })),
    name: "Board UI",
    description: "Navigation, command, and operator layout polish.",
    status: "in_progress",
    leadAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    targetDate: "2026-04-30",
    color: "#0f766e",
    icon: null,
    env: null,
    pauseReason: null,
    pausedAt: null,
    archivedAt: null,
    createdAt: recent(18_000),
    updatedAt: recent(12),
    ...overrides,
  };
}

export const storybookProjects: Project[] = [
  createProject(),
  createProject({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    name: "Agent Runtime",
    description: "Runtime adapters and execution trace work.",
    status: "planned",
    leadAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    color: "#2563eb",
    updatedAt: recent(60),
  }),
  createProject({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
    name: "Budget Guardrails",
    description: "Hard-stop and approval flow review surfaces.",
    status: "in_progress",
    leadAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    color: "#f59e0b",
    pauseReason: "budget",
    pausedAt: recent(90),
    updatedAt: recent(90),
  }),
  createProject({
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4",
    name: "Archived Import Wizard",
    description: "Preserved for audit after the import workflow moved into company packages.",
    status: "cancelled",
    leadAgentId: null,
    goalIds: ["cccccccc-cccc-4ccc-8ccc-ccccccccccc6"],
    goals: [
      {
        id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc6",
        title: "Retire old import wizard",
      },
    ],
    color: "#64748b",
    archivedAt: recent(2_400),
    updatedAt: recent(2_400),
  }),
];
