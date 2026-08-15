// @vitest-environment node

import { describe, expect, it } from "vitest";
import { mapCommentMetadataToSystemNoticeSections } from "./system-notice-comment";

describe("mapCommentMetadataToSystemNoticeSections", () => {
  it("maps server metadata row types to SystemNotice rows", () => {
    const sections = mapCommentMetadataToSystemNoticeSections({
      version: 1,
      sections: [
        {
          title: "Required action",
          rows: [
            {
              type: "task_link",
              label: "Source task",
              taskId: "123e4567-e89b-42d3-a456-426614174000",
              taskNumber: 3440,
              identifier: "PAP-3440",
              title: "Recovery",
            },
            { type: "agent_link", label: "Responsible", agentId: "agent-1", name: "CodexCoder" },
            { type: "key_value", label: "Status before", value: "in_progress" },
            { type: "code", label: "Cause code", code: "workspace_validation_failed" },
            { type: "text", label: "Notes", text: "Pick a disposition." },
            {
              type: "run_link",
              label: "Source run",
              runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
              title: "succeeded",
            },
          ],
        },
      ],
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]?.title).toBe("Required action");

    const rows = sections[0]!.rows;
    expect(rows).toEqual([
      {
        kind: "task",
        label: "Source task",
        taskNumber: 3440,
        identifier: "PAP-3440",
        link: true,
        title: "Recovery",
      },
      { kind: "agent", label: "Responsible", name: "CodexCoder", agentId: "agent-1" },
      { kind: "text", label: "Status before", value: "in_progress" },
      { kind: "code", label: "Cause code", value: "workspace_validation_failed" },
      { kind: "text", label: "Notes", value: "Pick a disposition." },
      {
        kind: "run",
        label: "Source run",
        runId: "9cdba892-c7ca-4d93-8604-4843873b127c",
        status: "succeeded",
      },
    ]);
  });

  it("preserves run metadata without inventing a producing agent", () => {
    const sections = mapCommentMetadataToSystemNoticeSections({
      version: 1,
      sections: [
        {
          rows: [{ type: "run_link", label: "Run", runId: "abc12345" }],
        },
      ],
    });

    expect(sections[0]?.rows[0]).toEqual({
      kind: "run",
      label: "Run",
      runId: "abc12345",
      status: undefined,
    });
  });

  it("returns an empty array for null metadata", () => {
    expect(mapCommentMetadataToSystemNoticeSections(null)).toEqual([]);
    expect(mapCommentMetadataToSystemNoticeSections(undefined)).toEqual([]);
  });
});
