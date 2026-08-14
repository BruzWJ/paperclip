import * as t from "./company-portability.test-support.js";
const { describe, it, companyPortabilityService, projectSvc, taskSvc, asTextFile } = t;
const { inlineSource } = t;
const { expect, companySvc, accessSvc, agentSvc, canonicalCompanyExtensionYaml } = t;
const { taskSessionProducers } = t;
import { registerSuiteSetup } from "./company-portability.test-setup-01.js";

describe("company portability", () => {
  registerSuiteSetup();

  it("round-trips terminal lifecycle and strict disposition in preview", async () => {
    const portability = companyPortabilityService({} as any);
    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-terminal",
        identifier: "PAP-9",
        title: "Completed portable task",
        request: "Preserve this completed request.",
        projectId: null,
        ownerAgentId: "agent-1",
        boardPresentationStatus: "done",
        lifecycleStatus: "done",
        disposition: {
          message: "Completed exactly.",
          structuredResult: null,
        },
        priority: "medium",
        labelIds: [],
        billingCode: null,
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: {
        company: true,
        agents: false,
        projects: false,
        tasks: true,
      },
    });
    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain('lifecycleStatus: "done"');
    expect(extension).toContain('message: "Completed exactly."');
    expect(extension).toContain("structuredResult: null");
    expect(extension).not.toContain("contextAccessMask");
    expect(exported.manifest.tasks[0]).toMatchObject({
      lifecycleStatus: "done",
      disposition: {
        message: "Completed exactly.",
        structuredResult: null,
      },
    });

    const preview = await portability.previewImport({
      source: inlineSource(exported),
      include: {
        company: true,
        agents: false,
        projects: false,
        tasks: true,
      },
      target: {
        mode: "existing_company",
        companyId: "company-1",
      },
      agents: "all",
      collisionStrategy: "rename",
    });
    expect(preview.errors).toEqual([]);
    expect(preview.manifest.tasks[0]).toMatchObject({
      lifecycleStatus: "done",
      disposition: {
        message: "Completed exactly.",
        structuredResult: null,
      },
    });
  });

  it("rejects retired context access masks in portable task and routine manifests", async () => {
    const portability = companyPortabilityService({} as any);
    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-imported",
        name: "Owner",
        status: "idle",
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    const files = {
      "COMPANY.md": "---\nname: Imported\n---\n",
      "tasks/narrowed/TASK.md": [
        "---",
        "name: Narrowed",
        "slug: narrowed",
        "owner: owner",
        "---",
        "",
        "Use only narrowed context.",
      ].join("\n"),
      ".paperclip.yaml": [
        "schema: paperclip/v1",
        ...canonicalCompanyExtensionYaml(),
        "tasks:",
        "  narrowed:",
        "    lifecycleStatus: open",
        "    boardPresentationStatus: todo",
        "    contextAccessMask:",
        "      carry_context: true",
        "      read_task_comments: false",
        "",
      ].join("\n"),
    };

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "imported",
          files,
        },
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: true,
        },
        target: {
          mode: "new_company",
          newCompanyName: "Imported",
        },
        agents: "all",
        collisionStrategy: "rename",
      }),
    ).rejects.toThrow("Task narrowed manifest contains unsupported fields: contextAccessMask");

    await expect(
      portability.previewImport({
        source: {
          type: "inline",
          rootPath: "imported",
          files: {
            ...files,
            ".paperclip.yaml": asTextFile(files[".paperclip.yaml"])
              .replace(
                "    contextAccessMask:\n      carry_context: true\n      read_task_comments: false\n",
                "",
              )
              .concat(
                [
                  "routines:",
                  "  narrowed:",
                  "    contextAccessMask:",
                  "      read_task_comments: false",
                  "",
                ].join("\n"),
              ),
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
          newCompanyName: "Imported",
        },
        agents: "all",
        collisionStrategy: "rename",
      }),
    ).rejects.toThrow("Routine manifest contains unsupported fields: contextAccessMask");
  });

  it("preserves task comment presentation fields on export and imports through the canonical Session producer", async () => {
    const portability = companyPortabilityService({} as any);
    const presentation = {
      kind: "system_notice",
      tone: "warning",
      detailsDefaultOpen: false,
    };
    const metadata = {
      version: 1,
      sections: [
        {
          rows: [
            {
              type: "key_value",
              label: "Cause",
              value: "successful_run_missing_state",
            },
          ],
        },
      ],
    };

    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Needs disposition",
        request: "System notice source",
        projectId: null,
        ownerAgentId: "agent-1",
        boardPresentationStatus: "todo",
        lifecycleStatus: "open",
        priority: "high",
        labelIds: [],
        billingCode: null,
        assigneeAdapterOverrides: null,
      },
    ]);
    taskSvc.listComments.mockResolvedValue([
      {
        id: "comment-1",
        taskId: "task-1",
        companyId: "company-1",
        authorType: "system",
        authorAgentId: null,
        authorUserId: null,
        body: "Paperclip needs a disposition before this task can continue.",
        presentation,
        metadata,
        createdAt: new Date("2026-05-04T12:00:00.000Z"),
        updatedAt: new Date("2026-05-04T12:00:00.000Z"),
      },
      {
        id: "comment-2",
        taskId: "task-1",
        companyId: "company-1",
        authorType: "agent",
        authorAgentId: "agent-1",
        authorUserId: null,
        body: "Historical agent output.",
        presentation: null,
        metadata: null,
        createdAt: new Date("2026-05-04T12:05:00.000Z"),
        updatedAt: new Date("2026-05-04T12:05:00.000Z"),
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: { company: true, agents: false, projects: false, tasks: true },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain("comments:");
    expect(extension).toContain("system_notice");
    expect(extension).toContain("successful_run_missing_state");

    companySvc.create.mockResolvedValue({
      id: "company-imported",
      name: "Imported",
    });
    accessSvc.ensureMembership.mockResolvedValue(undefined);
    agentSvc.list.mockResolvedValue([
      {
        id: "agent-imported",
        name: "ClaudeCoder",
        status: "idle",
      },
    ]);
    projectSvc.list.mockResolvedValue([]);
    const imported = await portability.importBundle(
      {
        source: inlineSource(exported),
        include: {
          company: true,
          agents: false,
          projects: false,
          tasks: true,
        },
        target: { mode: "new_company", newCompanyName: "Imported" },
        agents: "all",
        collisionStrategy: "rename",
      },
      "user-1",
    );

    expect(taskSessionProducers.appendCanonicalControlNotice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-imported",
        taskId: "task-imported",
        exactText: "Paperclip needs a disposition before this task can continue.",
        comment: {
          author: { kind: "system", source: "control" },
          producingRun: null,
        },
        occurredAt: "2026-05-04T12:00:00.000Z",
      }),
    );
    expect(taskSessionProducers.appendCanonicalControlNotice).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-imported",
        taskId: "task-imported",
        exactText: "Historical agent output.",
        comment: {
          author: { kind: "system", source: "control" },
          producingRun: null,
        },
        occurredAt: "2026-05-04T12:05:00.000Z",
      }),
    );
    expect(imported.warnings).toContain(
      "Comment on task needs-disposition from agent claudecoder was imported with system provenance because the portable comment does not include the producing run and adapter revision required for canonical agent attribution.",
    );
  });

  it("does not export raw comment author user ids", async () => {
    const portability = companyPortabilityService({} as any);

    projectSvc.list.mockResolvedValue([]);
    taskSvc.list.mockResolvedValue([
      {
        id: "task-1",
        identifier: "PAP-1",
        title: "Private board note",
        request: "Need private follow-up.",
        projectId: null,
        ownerAgentId: "agent-1",
        boardPresentationStatus: "todo",
        lifecycleStatus: "open",
        priority: "medium",
        labelIds: [],
        billingCode: null,
        assigneeAdapterOverrides: null,
      },
    ]);
    taskSvc.listComments.mockResolvedValue([
      {
        id: "comment-1",
        taskId: "task-1",
        companyId: "company-1",
        authorType: "user",
        authorAgentId: null,
        authorUserId: "board-user",
        body: "Need private follow-up.",
        presentation: null,
        metadata: null,
        createdAt: new Date("2026-05-04T12:00:00.000Z"),
        updatedAt: new Date("2026-05-04T12:00:00.000Z"),
      },
    ]);

    const exported = await portability.exportBundle("company-1", {
      include: { company: true, agents: false, projects: false, tasks: true },
    });

    const extension = asTextFile(exported.files[".paperclip.yaml"]);
    expect(extension).toContain('authorType: "user"');
    expect(extension).not.toContain("authorUserId: board-user");
  });
});
