import { describe, expect, it } from "vitest";
import {
  assertTaskSessionRunProgressProjection,
  type TaskSessionCommentProjectionInput,
} from "./projector.js";

const runId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";

function progressProjection(): TaskSessionCommentProjectionInput {
  return {
    phase: "direct",
    sourceKind: "run_progress",
    sourceId: runId,
    messageId: "msg_progress",
    comment: {
      id: "33333333-3333-4333-8333-333333333333",
      body: "",
      authorType: "agent",
      authorAgentId: agentId,
      authorUserId: null,
      authorPluginInstallationId: null,
      authorPluginKey: null,
      replyToCommentId: null,
      replyToProjectedEventSeq: null,
      threadRootCommentId: null,
      threadRootProjectedEventSeq: null,
      presentation: {
        kind: "run_progress",
        tone: "neutral",
        detailsDefaultOpen: false,
      },
    },
  };
}

describe("Task Session run-progress projection", () => {
  it("accepts only the stable empty comment owned by its producing run", () => {
    expect(() => assertTaskSessionRunProgressProjection(
      { id: "evt_progress", runId, agentId },
      progressProjection(),
    )).not.toThrow();
    expect(() => assertTaskSessionRunProgressProjection(
      { id: "evt_progress", runId, agentId },
      {
        ...progressProjection(),
        comment: { ...progressProjection().comment, body: "Working…" },
      },
    )).toThrow("empty stable comment");
    expect(() => assertTaskSessionRunProgressProjection(
      { id: "evt_progress", runId, agentId },
      { ...progressProjection(), sourceId: agentId },
    )).toThrow("empty stable comment");
  });
});
