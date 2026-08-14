import * as t from "./company-portability.test-support.js";
const { describe, it, companyPortabilityService, companySvc, accessSvc, agentSvc } = t;
const { projectSvc, canonicalCompanyExtensionYaml, canonicalAgentExtensionYaml } = t;
const { codexTargetAdapter, expect, routineSvc, ordinaryTaskRuntime } = t;
import { registerSuiteSetup } from "./company-portability.test-setup-01.js";

describe("company portability", () => {
  registerSuiteSetup();

  it("imports recurring task packages as routines instead of one-time tasks", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });
    projectSvc.create.mockResolvedValue({
      id: "project-created",
      name: "Launch",
    });
    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);

    const files = {
      "COMPANY.md": ["---", 'schema: "agentcompanies/v1"', 'name: "Imported Paperclip"', "---", ""].join(
        "\n",
      ),
      "agents/claudecoder/AGENTS.md": [
        "---",
        'kind: "agent"',
        'slug: "claudecoder"',
        'name: "ClaudeCoder"',
        "reportsTo: null",
        "---",
        "",
      ].join("\n"),
      "projects/launch/PROJECT.md": [
        "---",
        'kind: "project"',
        'slug: "launch"',
        'name: "Launch"',
        "---",
        "",
      ].join("\n"),
      "tasks/monday-review/TASK.md": [
        "---",
        'kind: "task"',
        'slug: "monday-review"',
        'name: "Monday Review"',
        'project: "launch"',
        'owner: "claudecoder"',
        "recurring: true",
        "---",
        "",
        "Review pipeline health.",
        "",
      ].join("\n"),
      ".paperclip.yaml": [
        'schema: "paperclip/v1"',
        ...canonicalCompanyExtensionYaml(),
        "agents:",
        "  claudecoder:",
        ...canonicalAgentExtensionYaml(),
        "tasks:",
        "  monday-review:",
        '    lifecycleStatus: "open"',
        '    boardPresentationStatus: "paused"',
        '    priority: "high"',
        "routines:",
        "  monday-review:",
        '    concurrencyPolicy: "always_enqueue"',
        '    catchUpPolicy: "enqueue_missed_with_cap"',
        "    triggers:",
        "      - kind: schedule",
        '        cronExpression: "0 9 * * 1"',
        '        timezone: "America/Chicago"',
        "      - kind: webhook",
        "        enabled: false",
        '        signingMode: "hmac_sha256"',
        "        replayWindowSec: 120",
        "",
      ].join("\n"),
    };

    const preview = await portability.previewImport({
      source: { type: "inline", rootPath: "paperclip-demo", files },
      include: {
        company: true,
        agents: true,
        projects: true,
        tasks: true,
      },
      target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
      agents: "all",
      collisionStrategy: "rename",
      adapterOverrides: {
        claudecoder: codexTargetAdapter(),
      },
    });

    expect(preview.errors).toEqual([]);
    expect(preview.plan.taskPlans).toEqual([
      expect.objectContaining({
        slug: "monday-review",
        reason: "Recurring task will be imported as a routine.",
      }),
    ]);

    const result = await portability.importBundle(
      {
        source: { type: "inline", rootPath: "paperclip-demo", files },
        include: {
          company: true,
          agents: true,
          projects: true,
          tasks: true,
        },
        target: { mode: "new_company", newCompanyName: "Imported Paperclip" },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
        },
      },
      "user-1",
    );

    expect(routineSvc.create).toHaveBeenCalledWith(
      "company-imported",
      expect.objectContaining({
        projectId: "project-created",
        title: "Monday Review",
        assigneeAgentId: "agent-created",
        priority: "high",
        status: "paused",
        concurrencyPolicy: "always_enqueue",
        catchUpPolicy: "enqueue_missed_with_cap",
      }),
      expect.any(Object),
    );
    expect(result.warnings).not.toContain(
      "Task monday-review assignee claudecoder is pending_approval; imported work was left unassigned.",
    );
    expect(routineSvc.createTrigger).toHaveBeenCalledTimes(2);
    expect(routineSvc.createTrigger).toHaveBeenCalledWith(
      "routine-created",
      expect.objectContaining({
        kind: "schedule",
        cronExpression: "0 9 * * 1",
        timezone: "America/Chicago",
      }),
      expect.any(Object),
    );
    expect(routineSvc.createTrigger).toHaveBeenCalledWith(
      "routine-created",
      expect.objectContaining({
        kind: "webhook",
        enabled: false,
        signingMode: "hmac_sha256",
        replayWindowSec: 120,
      }),
      expect.any(Object),
    );
    expect(ordinaryTaskRuntime.create).not.toHaveBeenCalled();
  });

  it("rejects legacy schedule.recurrence packages without the canonical manifest", async () => {
    const portability = companyPortabilityService({} as any);

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported Paperclip",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.create.mockResolvedValue({
      id: "agent-created",
      name: "ClaudeCoder",
    });
    projectSvc.create.mockResolvedValue({
      id: "project-created",
      name: "Launch",
    });
    agentSvc.list.mockResolvedValue([]);
    projectSvc.list.mockResolvedValue([]);

    const files = {
      "COMPANY.md": ["---", 'schema: "agentcompanies/v1"', 'name: "Imported Paperclip"', "---", ""].join(
        "\n",
      ),
      "agents/claudecoder/AGENTS.md": ["---", 'name: "ClaudeCoder"', "---", "", "You write code.", ""].join(
        "\n",
      ),
      "projects/launch/PROJECT.md": ["---", 'name: "Launch"', "---", ""].join("\n"),
      "tasks/monday-review/TASK.md": [
        "---",
        'name: "Monday Review"',
        'project: "launch"',
        'owner: "claudecoder"',
        "schedule:",
        '  timezone: "America/Chicago"',
        '  startsAt: "2026-03-16T09:00:00-05:00"',
        "  recurrence:",
        '    frequency: "weekly"',
        "    interval: 1",
        "    weekdays:",
        '      - "monday"',
        "---",
        "",
        "Review pipeline health.",
        "",
      ].join("\n"),
    };

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "paperclip-demo",
          files,
        },
        include: {
          company: true,
          agents: true,
          projects: true,
          tasks: true,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
        agents: "all",
        collisionStrategy: "rename",
        adapterOverrides: {
          claudecoder: codexTargetAdapter(),
        },
      }),
    ).rejects.toThrow("missing the canonical .paperclip.yaml manifest");
    expect(ordinaryTaskRuntime.create).not.toHaveBeenCalled();
  });

  it("rejects a canonical recurring task without an explicit owner", async () => {
    const portability = companyPortabilityService({} as any);

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "paperclip-demo",
          files: {
            "COMPANY.md": [
              "---",
              'schema: "agentcompanies/v1"',
              'name: "Imported Paperclip"',
              "---",
              "",
            ].join("\n"),
            "tasks/monday-review/TASK.md": [
              "---",
              'name: "Monday Review"',
              "slug: monday-review",
              "recurring: true",
              "---",
              "",
              "Review pipeline health.",
              "",
            ].join("\n"),
            ".paperclip.yaml": [
              'schema: "paperclip/v1"',
              ...canonicalCompanyExtensionYaml(),
              "tasks:",
              "  monday-review:",
              '    lifecycleStatus: "open"',
              '    boardPresentationStatus: "active"',
              "routines:",
              "  monday-review:",
              "    triggers: []",
              "",
            ].join("\n"),
          },
        },
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: true,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
        collisionStrategy: "rename",
      }),
    ).rejects.toThrow("Task monday-review requires an explicit owner");
  });

  it("rejects a package without the canonical .paperclip.yaml manifest", async () => {
    const portability = companyPortabilityService({} as any);

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "paperclip-demo",
          files: {
            "COMPANY.md": [
              "---",
              'schema: "agentcompanies/v1"',
              'name: "Imported Paperclip"',
              "---",
              "",
            ].join("\n"),
          },
        },
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: false,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Imported Paperclip",
        },
      }),
    ).rejects.toThrow("missing the canonical .paperclip.yaml manifest");
  });
});
