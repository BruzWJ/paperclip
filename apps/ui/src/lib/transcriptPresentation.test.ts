import { describe, expect, it } from "vitest";
import { describeToolInput, summarizeToolInput } from "./transcriptPresentation";

describe("summarizeToolInput", () => {
  it("prefers human descriptions over raw commands when both exist", () => {
    expect(
      summarizeToolInput("command_execution", {
        description: "Inspect the task chat thread layout classes",
        command:
          "zsh -lc 'sed -n \"1,220p\" apps/ui/src/routes/_authenticated/\\$companyId/tasks/\\$taskNumber/-task-chat/-TaskChatThread.tsx'",
      }),
    ).toBe("Inspect the task chat thread layout classes");
  });
});

describe("describeToolInput", () => {
  it("keeps command tools description-first in the detail view", () => {
    expect(
      describeToolInput("command_execution", {
        description: "Inspect the task chat thread layout classes",
        command:
          "zsh -lc 'sed -n \"1,220p\" apps/ui/src/routes/_authenticated/\\$companyId/tasks/\\$taskNumber/-task-chat/-TaskChatThread.tsx'",
        cwd: "/workspace/paperclip",
      }),
    ).toEqual([
      { label: "Intent", value: "Inspect the task chat thread layout classes", tone: "default" },
      { label: "Directory", value: "/workspace/paperclip", tone: "default" },
    ]);
  });

  it("surfaces concise structured details for file tools", () => {
    expect(
      describeToolInput("read_file", {
        path: "apps/ui/src/lib/task-chat-messages.ts",
      }),
    ).toEqual([
      { label: "Path", value: "apps/ui/src/lib/task-chat-messages.ts", tone: "default" },
    ]);
  });
});
