import { describe, expect, it } from "vitest";

import { TaskSession as RootTaskSession } from "../index.js";
import {
  Event,
  decodeDurableTaskSessionEventRow,
  decodeTaskSessionEvent,
  decodeTaskSessionInfo,
  decodeTaskSessionMessage,
  decodeTaskSessionPrompt,
  encodeDurableTaskSessionEventRow,
  encodeTaskSessionEvent,
  encodeTaskSessionInfo,
  encodeTaskSessionMessage,
  encodeTaskSessionPrompt,
  taskSessionEventDefinition,
  versionedTaskSessionEventType,
} from "../task-session.js";

const baseMessage = {
  id: "msg_contract",
  time: { created: 1_700_000_000_000 },
};

const model = {
  id: "model",
  providerID: "provider",
  variant: "default",
};

describe("task-session shared contracts", () => {
  it("owns all seven canonical message kinds and preserves their wire values", () => {
    const messages = [
      { ...baseMessage, type: "agent-switched", agent: "agent" },
      { ...baseMessage, type: "model-switched", model },
      { ...baseMessage, type: "user", text: "request" },
      {
        ...baseMessage,
        type: "synthetic",
        sessionID: "ses_contract",
        text: "continue",
      },
      { ...baseMessage, type: "system", text: "notice" },
      {
        ...baseMessage,
        type: "shell",
        callID: "call",
        command: "pwd",
        output: "/workspace",
      },
      {
        ...baseMessage,
        type: "assistant",
        agent: "agent",
        model,
        content: [],
      },
    ] as const;

    expect(
      messages.map((wire) => encodeTaskSessionMessage(
        decodeTaskSessionMessage(wire),
      )),
    ).toEqual(messages);
    expect(messages.map((message) => message.type)).toEqual([
      "agent-switched",
      "model-switched",
      "user",
      "synthetic",
      "system",
      "shell",
      "assistant",
    ]);
  });

  it("rejects retired Paperclip compaction messages and event definitions", () => {
    expect(() =>
      decodeTaskSessionMessage({
        ...baseMessage,
        type: "compaction",
        reason: "manual",
        summary: "summary",
        recent: "tail",
      }),
    ).toThrow();
    expect(
      taskSessionEventDefinition("session.next.compaction.started.1"),
    ).toBeUndefined();
  });

  it("round-trips completed tool metadata without clearing auditable output", () => {
    const message = {
      ...baseMessage,
      type: "assistant",
      agent: "agent",
      model,
      content: [
        {
          type: "tool",
          id: "tool-1",
          name: "read_file",
          provider: {
            executed: true,
            metadata: { provider: { requestId: "request-1" } },
            resultMetadata: { provider: { traceId: "trace-1" } },
          },
          state: {
            status: "completed",
            input: { path: "/workspace/secret.txt" },
            structured: { source: "filesystem" },
            content: [{ type: "text", text: "auditable tool output" }],
            outputPaths: ["/workspace/secret.txt"],
            result: { bytes: 21 },
          },
          time: {
            created: 1_700_000_000_000,
            ran: 1_700_000_000_001,
            completed: 1_700_000_000_002,
          },
        },
        {
          type: "tool",
          id: "tool-error",
          name: "write_file",
          state: {
            status: "error",
            input: { path: "/workspace/secret.txt" },
            structured: {},
            content: [{ type: "text", text: "partial output" }],
            error: { type: "unknown", message: "write failed" },
          },
          time: {
            created: 1_700_000_000_004,
            completed: 1_700_000_000_005,
          },
        },
      ],
    } as const;

    expect(
      encodeTaskSessionMessage(decodeTaskSessionMessage(message)),
    ).toEqual(message);
  });

  it("preserves ACP assistant steps with no portable model metadata", () => {
    const assistant = {
      ...baseMessage,
      type: "assistant",
      agent: "agent",
      content: [],
    } as const;
    const event = {
      id: "evt_model_unknown",
      type: Event.Step.Started.type,
      durable: {
        aggregateID: "ses_contract",
        seq: 5,
        version: 1,
      },
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: "ses_contract",
        assistantMessageID: "msg_contract",
        agent: "agent",
      },
    } as const;

    expect(
      encodeTaskSessionMessage(decodeTaskSessionMessage(assistant)),
    ).toEqual(assistant);
    expect(
      encodeTaskSessionEvent(decodeTaskSessionEvent(event)),
    ).toEqual(event);
  });

  it("derives durable event versions from the canonical definitions", () => {
    expect(versionedTaskSessionEventType(Event.Step.Ended.type)).toBe(
      "session.next.step.ended.3",
    );
    expect(versionedTaskSessionEventType(Event.Step.Failed.type)).toBe(
      "session.next.step.failed.2",
    );
    expect(versionedTaskSessionEventType(Event.Prompted.type)).toBe(
      "session.next.prompted.1",
    );
  });

  it("round-trips the physical durable-event row without a handwritten version map", () => {
    const row = {
      id: "evt_contract",
      sessionId: "ses_contract",
      seq: 4,
      type: "session.next.prompted.1",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: "ses_contract",
        messageID: "msg_contract",
        prompt: { text: "request" },
      },
    };

    const event = decodeDurableTaskSessionEventRow(row);
    expect(encodeDurableTaskSessionEventRow(event)).toEqual(row);
    expect(encodeTaskSessionEvent(decodeTaskSessionEvent({
      ...event,
      data: row.data,
    }))).toEqual({
      id: row.id,
      type: "session.next.prompted",
      durable: {
        aggregateID: row.sessionId,
        seq: row.seq,
        version: 1,
      },
      data: row.data,
    });
  });

  it("exports the same first-class contracts from the shared package root", () => {
    expect(RootTaskSession.Event.Prompted.type).toBe(
      "session.next.prompted",
    );
    expect(RootTaskSession.Message.Message).toBeDefined();
  });

  it("round-trips prompt and session-info storage JSON", () => {
    const prompt = {
      text: "request",
      files: [{ uri: "file:///workspace/a.txt", mime: "text/plain" }],
    };
    const info = {
      id: "ses_contract",
      projectID: "global",
      cost: 0,
      tokens: {
        input: 1,
        output: 2,
        reasoning: 3,
        cache: { read: 4, write: 5 },
      },
      time: {
        created: 1_700_000_000_000,
        updated: 1_700_000_000_001,
      },
      title: "Task",
      location: { directory: "/workspace" },
    };

    expect(encodeTaskSessionPrompt(decodeTaskSessionPrompt(prompt))).toEqual(
      prompt,
    );
    expect(encodeTaskSessionInfo(decodeTaskSessionInfo(info))).toEqual(info);
  });

  it("preserves unavailable and explicit-zero Session accounting without sentinels", () => {
    const withoutAccounting = {
      id: "ses_without_accounting",
      projectID: "global",
      time: {
        created: 1_700_000_000_000,
        updated: 1_700_000_000_001,
      },
      title: "Task",
      location: { directory: "/workspace" },
    };
    const explicitZero = {
      ...withoutAccounting,
      id: "ses_zero_accounting",
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };

    expect(
      encodeTaskSessionInfo(decodeTaskSessionInfo(withoutAccounting)),
    ).toEqual(withoutAccounting);
    expect(
      encodeTaskSessionInfo(decodeTaskSessionInfo(explicitZero)),
    ).toEqual(explicitZero);
    expect(() => decodeTaskSessionInfo({
      ...withoutAccounting,
      cost: null,
    })).toThrow();
    expect(() => decodeTaskSessionInfo({
      ...withoutAccounting,
      tokens: { input: 0 },
    })).toThrow();
  });

  it("uses only Step.Ended.3 and keeps its accounting objects all-or-none", () => {
    const row = {
      id: "evt_step_ended",
      sessionId: "ses_contract",
      seq: 7,
      type: "session.next.step.ended.3",
      data: {
        timestamp: 1_700_000_000_000,
        sessionID: "ses_contract",
        assistantMessageID: "msg_contract",
        finish: "stop",
      },
    };
    expect(
      encodeDurableTaskSessionEventRow(
        decodeDurableTaskSessionEventRow(row),
      ),
    ).toEqual(row);

    const explicitZero = {
      ...row,
      data: {
        ...row.data,
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    };
    expect(
      encodeDurableTaskSessionEventRow(
        decodeDurableTaskSessionEventRow(explicitZero),
      ),
    ).toEqual(explicitZero);
    expect(() => decodeDurableTaskSessionEventRow({
      ...row,
      type: "session.next.step.ended.2",
    })).toThrow("Unknown durable task-session event type");
    expect(() => decodeDurableTaskSessionEventRow({
      ...row,
      data: { ...row.data, cost: null },
    })).toThrow();
    expect(() => decodeDurableTaskSessionEventRow({
      ...row,
      data: { ...row.data, tokens: { input: 0 } },
    })).toThrow();
  });
});
