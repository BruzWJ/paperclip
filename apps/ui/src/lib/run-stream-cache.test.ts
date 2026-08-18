import { describe, expect, it, vi } from "vitest";
import type { RunStreamAssistantMessage, RunStreamLiveEventPayload } from "@paperclipai/shared";
import type { TaskExecutionRunJoinedDetail } from "../api/runs";
import {
  applyRunStateEventToCache,
  applyRunStreamEventToCache,
  applyRunStreamProjection,
  applyRunStreamSnapshot,
} from "./run-stream-cache";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
type PartProjection = Extract<RunStreamLiveEventPayload, { kind: "part.upsert" }>;

function detail(messages: TaskExecutionRunJoinedDetail["sessionMessages"]["items"] = []) {
  return {
    run: { id: RUN_ID },
    sessionMessages: { items: messages, truncated: false },
  } as TaskExecutionRunJoinedDetail;
}

function projection(overrides: Partial<PartProjection> = {}): PartProjection {
  return {
    kind: "part.upsert",
    runId: RUN_ID,
    message: {
      id: "assistant-1",
      seq: 5,
      modelStateSeq: 7,
      type: "assistant",
      data: { content: [] },
      timeCreated: "2026-01-01T00:00:00.000Z",
      timeUpdated: "2026-01-01T00:00:01.000Z",
    },
    part: { id: "text-1", type: "text", text: "hello" },
    ...overrides,
  };
}

describe("run-stream Socket.IO cache projection", () => {
  it("creates the assistant message from the first websocket part", () => {
    const next = applyRunStreamProjection(detail(), projection());
    expect(next.sessionMessages.items).toEqual([
      expect.objectContaining({
        id: "assistant-1",
        modelStateSeq: 7,
        data: expect.objectContaining({
          content: [{ id: "text-1", type: "text", text: "hello" }],
        }),
      }),
    ]);
  });

  it("upserts full parts and ignores duplicate or older delivery", () => {
    const first = applyRunStreamProjection(detail(), projection());
    const duplicate = applyRunStreamProjection(first, projection());
    expect(duplicate).toBe(first);

    const updated = applyRunStreamProjection(
      first,
      projection({
        message: { ...projection().message, modelStateSeq: 8 },
        part: { id: "text-1", type: "text", text: "hello world" },
      }),
    );
    expect(updated.sessionMessages.items[0]?.data.content).toEqual([
      { id: "text-1", type: "text", text: "hello world" },
    ]);
  });

  it("restores a missed range from a websocket snapshot without losing newer state", () => {
    const snapshot: RunStreamAssistantMessage = {
      ...projection().message,
      modelStateSeq: 12,
      data: {
        content: [
          { id: "text-1", type: "text", text: "hello" },
          { id: "tool-1", type: "tool", state: { status: "completed" } },
        ],
      },
    };
    const restored = applyRunStreamSnapshot(detail(), RUN_ID, snapshot);
    expect(restored.sessionMessages.items[0]?.data.content).toEqual(snapshot.data.content);
    expect(applyRunStreamSnapshot(restored, RUN_ID, { ...snapshot, modelStateSeq: 11 })).toBe(restored);
  });

  it("does not create a partial run-detail query before its initial load", () => {
    const setQueryData = vi.fn((_key, update: (value: undefined) => undefined) => update(undefined));
    applyRunStreamEventToCache({ setQueryData } as never, projection());
    expect(setQueryData.mock.results[0]?.value).toBeUndefined();
  });

  it("applies terminal run state directly without refetching the detail", () => {
    let cached = detail();
    const setQueryData = vi.fn((_key, update: (value: typeof cached) => typeof cached) => {
      cached = update(cached);
    });

    applyRunStateEventToCache({ setQueryData } as never, { run: { ...cached.run, status: "succeeded" } });

    expect(cached.run.status).toBe("succeeded");
  });
});
