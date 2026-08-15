import type { AcpPromptAccountingRecord, TaskExecutionSessionMessageRecord } from "@/api/runs";
import type { TaskExecutionRunEnvelopeRecord } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import {
  collectRunOutputs,
  decodeRunMessage,
  humanizeRunValue,
  latestAccountingRecord,
  runDurationMs,
} from "./agent-run-detail-model";

function messageRecord(
  type: TaskExecutionSessionMessageRecord["type"],
  data: Record<string, unknown>,
): TaskExecutionSessionMessageRecord {
  return {
    id: "msg_contract",
    seq: 1,
    modelStateSeq: 1,
    type,
    data,
    timeCreated: "2026-08-14T12:00:00.000Z",
    timeUpdated: "2026-08-14T12:00:00.000Z",
  };
}

describe("agent run detail model", () => {
  it("decodes canonical stored session records and rejects malformed payloads", () => {
    const decoded = decodeRunMessage(
      messageRecord("user", {
        text: "Inspect the run",
        time: { created: 1_700_000_000_000 },
      }),
    );
    expect(decoded.message).toMatchObject({ type: "user", text: "Inspect the run" });
    expect(decodeRunMessage(messageRecord("user", { text: "Missing time" })).message).toBeNull();
  });

  it("collects and deduplicates only canonical assistant output paths", () => {
    const assistant = messageRecord("assistant", {
      agent: "builder",
      time: { created: 1_700_000_000_000, completed: 1_700_000_000_500 },
      snapshot: { files: ["src/result.ts", "src/result.ts"] },
      content: [
        {
          type: "tool",
          id: "tool_write",
          name: "write_file",
          state: {
            status: "completed",
            input: { path: "src/result.ts" },
            structured: {},
            content: [
              { type: "text", text: "written" },
              { type: "file", uri: "file:///workspace/report.md", mime: "text/markdown" },
            ],
            attachments: [
              { uri: "file:///workspace/report.md", mime: "text/markdown" },
              { uri: "file:///workspace/summary.json", mime: "application/json" },
            ],
            outputPaths: ["src/result.ts", "dist/result.js"],
            result: { written: true },
          },
          time: {
            created: 1_700_000_000_100,
            ran: 1_700_000_000_200,
            completed: 1_700_000_000_300,
          },
        },
      ],
    });
    expect(collectRunOutputs([assistant])).toEqual([
      {
        kind: "file_reference",
        mediaType: "text/markdown",
        name: undefined,
        value: "file:///workspace/report.md",
      },
      {
        kind: "file_reference",
        mediaType: "application/json",
        name: undefined,
        value: "file:///workspace/summary.json",
      },
      { kind: "workspace_path", value: "dist/result.js" },
      { kind: "workspace_path", value: "src/result.ts" },
    ]);
  });

  it("formats protocol values and calculates a finished run duration", () => {
    const run = {
      startedAt: "2026-08-14T12:00:00.000Z",
      finishedAt: "2026-08-14T12:01:30.000Z",
    } as TaskExecutionRunEnvelopeRecord;
    expect(runDurationMs(run)).toBe(90_000);
    expect(humanizeRunValue("session.next.step_ended.3")).toBe("step ended");
  });

  it("selects the latest accounting observation by settlement time", () => {
    const earlierSettlement = {
      id: "accounting-created-later",
      settledAt: "2026-08-14T12:00:00.000Z",
      createdAt: "2026-08-14T12:00:10.000Z",
    } as AcpPromptAccountingRecord;
    const laterSettlement = {
      id: "accounting-settled-later",
      settledAt: "2026-08-14T12:00:05.000Z",
      createdAt: "2026-08-14T12:00:06.000Z",
    } as AcpPromptAccountingRecord;

    expect(latestAccountingRecord([earlierSettlement, laterSettlement])).toBe(laterSettlement);
  });
});
