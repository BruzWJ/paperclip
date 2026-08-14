import "./company-portability.test-suite-01-fails-closed-for-unresolved-explicit.js";
import "./company-portability.test-suite-02-imports-agent-permission-grants-from.js";
import "./company-portability.test-suite-04-imports-recurring-task-packages-as.js";
import "./company-portability.test-suite-05-rejects-noncanonical-inline-file-root.js";
import "./company-portability.test-suite-06-imports-the-exact-immutable-adapter.js";
import "./company-portability.test-suite-07-round-trips-terminal-lifecycle-and.js";
import "./company-portability.test-suite-08-rejects-task-imports-without-a.js";
import * as t from "./company-portability.test-support.js";
const { describe, it, companyPortabilityService, projectSvc, routineSvc, expect } = t;
const { inlineSource } = t;
const { asTextFile, agentSvc, SOURCE_ADAPTER_REVISION_ID, taskSvc } = t;
const { codexTargetAdapter, ordinaryTaskRuntime } = t;
import { registerSuiteSetup } from "./company-portability.test-setup-01.js";

describe("company portability", () => {
  registerSuiteSetup();

  it("exports routines as recurring task packages with Paperclip routine extensions", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        name: "Launch",
        description: "Ship it",
        leadAgentId: "agent-1",
        targetDate: null,
        color: null,
        status: "planned",
        archivedAt: null,
      },
    ]);
    routineSvc.list.mockResolvedValue([
      {
        id: "routine-1",
        companyId: "company-1",
        projectId: "project-1",
        goalId: null,
        parentTaskId: null,
        title: "Monday Review",
        description: "Review pipeline health",
        assigneeAgentId: "agent-1",
        priority: "high",
        status: "paused",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "enqueue_missed_with_cap",
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        lastTriggeredAt: null,
        lastEnqueuedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        triggers: [
          {
            id: "trigger-1",
            companyId: "company-1",
            routineId: "routine-1",
            kind: "schedule",
            label: "Weekly cadence",
            enabled: true,
            cronExpression: "0 9 * * 1",
            timezone: "America/Chicago",
            nextRunAt: null,
            lastFiredAt: null,
            publicId: "public-1",
            secretId: "secret-1",
            signingMode: null,
            replayWindowSec: null,
            lastRotatedAt: null,
            lastResult: null,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: "trigger-2",
            companyId: "company-1",
            routineId: "routine-1",
            kind: "webhook",
            label: "External nudge",
            enabled: false,
            cronExpression: null,
            timezone: null,
            nextRunAt: null,
            lastFiredAt: null,
            publicId: "public-2",
            secretId: "secret-2",
            signingMode: "hmac_sha256",
            replayWindowSec: 120,
            lastRotatedAt: null,
            lastResult: null,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        lastRun: null,
        activeTask: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
        tasks: true,
      },
    });

    expect(asTextFile(exported.files["tasks/monday-review/TASK.md"])).toContain("recurring: true");
    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("routines:");
    expect(extension).toContain("monday-review:");
    expect(extension).toContain('cronExpression: "0 9 * * 1"');
    expect(extension).toContain('signingMode: "hmac_sha256"');
    expect(extension).not.toContain("contextAccessMask");
    expect(extension).not.toContain("secretId");
    expect(extension).not.toContain("publicId");
    expect(exported.manifest.tasks).toEqual([
      expect.objectContaining({
        slug: "monday-review",
        recurring: true,
        boardPresentationStatus: "paused",
        priority: "high",
        routine: expect.objectContaining({
          concurrencyPolicy: "always_enqueue",
          catchUpPolicy: "enqueue_missed_with_cap",
          triggers: expect.arrayContaining([
            expect.objectContaining({
              kind: "schedule",
              cronExpression: "0 9 * * 1",
              timezone: "America/Chicago",
            }),
            expect.objectContaining({
              kind: "webhook",
              enabled: false,
              signingMode: "hmac_sha256",
              replayWindowSec: 120,
            }),
          ]),
        }),
      }),
    ]);
  });

  it("exports formerly built-in records as ordinary agents and routines", async () => {
    const portability = companyPortabilityService({} as any);

    agentSvc.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        status: "idle",
        title: "Software Engineer",
        icon: "code",
        reportsTo: null,
        capabilities: "Writes code",
        currentAdapterConfigRevisionId: SOURCE_ADAPTER_REVISION_ID,
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
      {
        id: "agent-built-in",
        name: "Reflection Coach",
        status: "paused",
        title: "Reflection Coach",
        icon: "sparkles",
        reportsTo: null,
        capabilities: "Reviews trajectories",
        currentAdapterConfigRevisionId: "11111111-1111-4111-8111-111111111112",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);
    routineSvc.list.mockResolvedValue([
      {
        id: "routine-built-in",
        companyId: "company-1",
        projectId: null,
        goalId: null,
        parentTaskId: null,
        title: "Review recent agent trajectories for coaching proposals",
        description: "Review recent agent work and propose coaching follow-ups.",
        assigneeAgentId: "agent-built-in",
        priority: "medium",
        status: "paused",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        createdByAgentId: null,
        createdByUserId: null,
        updatedByAgentId: null,
        updatedByUserId: null,
        lastTriggeredAt: null,
        lastEnqueuedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        originKind: "built_in_agent_bundle",
        originId: "reflection-coach:recent-agent-reflection",
        originFingerprint: null,
        triggers: [
          {
            id: "trigger-built-in",
            companyId: "company-1",
            routineId: "routine-built-in",
            kind: "schedule",
            label: "Weekly review",
            enabled: false,
            cronExpression: "0 9 * * 1",
            timezone: "UTC",
            nextRunAt: null,
            lastFiredAt: null,
            publicId: "public-built-in",
            secretId: "secret-built-in",
            signingMode: null,
            replayWindowSec: null,
            lastRotatedAt: null,
            lastResult: null,
            createdByAgentId: null,
            createdByUserId: null,
            updatedByAgentId: null,
            updatedByUserId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
        lastRun: null,
        activeTask: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: true,
        projects: true,
        tasks: true,
      },
    });

    expect(exported.files["agents/claudecoder/AGENTS.md"]).toBeDefined();
    expect(exported.files["agents/reflection-coach/AGENTS.md"]).toBeDefined();
    expect(
      exported.files["tasks/review-recent-agent-trajectories-for-coaching-proposals/TASK.md"],
    ).toBeDefined();
    expect(exported.manifest.agents.map((agent) => agent.slug)).toEqual(["claudecoder", "reflection-coach"]);
    expect(exported.manifest.tasks).toEqual([
      expect.objectContaining({
        slug: "review-recent-agent-trajectories-for-coaching-proposals",
        recurring: true,
      }),
    ]);
    expect(exported.warnings).not.toContainEqual(expect.stringContaining("built-in managed"));
  });
});

describe("company portability cycle-safe export", () => {
  registerSuiteSetup();

  it("handles circular reportsTo chains without infinite recursion during export", async () => {
    const portability = companyPortabilityService({} as any);
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-a",
        name: "AgentA",
        status: "idle",
        title: null,
        icon: null,
        reportsTo: "agent-b",
        capabilities: null,
        currentAdapterConfigRevisionId: SOURCE_ADAPTER_REVISION_ID,
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
      {
        id: "agent-b",
        name: "AgentB",
        status: "idle",
        title: null,
        icon: null,
        reportsTo: "agent-a",
        capabilities: null,
        currentAdapterConfigRevisionId: "11111111-1111-4111-8111-111111111112",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: { company: true, agents: true, projects: false, tasks: false },
    });
    expect(exported.manifest.agents).toHaveLength(2);
    const slugs = exported.manifest.agents.map((agent) => agent.slug);
    expect(slugs).toContain("agenta");
    expect(slugs).toContain("agentb");
  });

  it("resolves task owner to an existing agent when the agent import is skipped", async () => {
    const portability = companyPortabilityService({} as any);
    projectSvc.list.mockResolvedValue([
      {
        id: "project-1",
        companyId: "company-1",
        name: "TestProject",
        description: null,
        leadAgentId: null,
        targetDate: null,
        color: null,
        status: "planned",
        archivedAt: null,
      },
    ]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-1",
        companyId: "company-1",
        title: "Test task",
        identifier: "PAP-1",
        request: "A test task",
        boardPresentationStatus: "todo",
        lifecycleStatus: "open",
        priority: "medium",
        ownerAgentId: "agent-1",
        projectId: "project-1",
        goalId: null,
        parentId: null,
        billingCode: null,
        labelIds: [],
        assigneeAdapterOverrides: null,
        metadata: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: { company: false, agents: true, projects: true, tasks: true },
    });
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-1",
        name: "ClaudeCoder",
        status: "idle",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
      {
        id: "agent-2",
        name: "Reviewer",
        status: "idle",
        budgetMonthlyAmount: "0",
        knownSpendAmount: "0",
        instruction: null,
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([]);
    projectSvc.create.mockResolvedValue({
      id: "project-new",
      companyId: "company-1",
    });
    const result = await portability.importBundle(
      {
        source: inlineSource(exported),
        include: {
          company: false,
          agents: true,
          projects: true,
          tasks: true,
        },
        target: { mode: "existing_company", companyId: "company-1" },
        agents: "all",
        collisionStrategy: "skip",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
          reviewer: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    const agentResult = result.agents.find((agent) => agent.slug === "claudecoder");
    expect(agentResult).toBeDefined();
    expect(agentResult!.action).toBe("skipped");
    expect(ordinaryTaskRuntime.create).toHaveBeenCalled();
    const taskCreateCall = ordinaryTaskRuntime.create.mock.calls[0];
    expect(taskCreateCall[0]).toEqual(expect.objectContaining({ ownerAgentId: "agent-1" }));
  });

  it("preview import detects no agents to import when agents are excluded", async () => {
    const portability = companyPortabilityService({} as any);
    const exported = await portability.exportBundle("company-1", {
      include: { company: true, agents: true, projects: false, tasks: false },
    });
    agentSvc.list.mockResolvedValue([]);
    const preview = await portability.previewImport({
      source: inlineSource(exported),
      include: {
        company: false,
        agents: false,
        projects: false,
        tasks: false,
      },
      target: { mode: "existing_company", companyId: "company-1" },
      agents: "all",
      collisionStrategy: "rename",
    });
    expect(preview.plan.agentPlans).toHaveLength(0);
    expect(preview.plan.projectPlans).toHaveLength(0);
    expect(preview.plan.taskPlans).toHaveLength(0);
  });
});
