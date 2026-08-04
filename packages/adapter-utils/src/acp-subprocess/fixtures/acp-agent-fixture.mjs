import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const fixtureMode = process.env.PAPERCLIP_ACP_FIXTURE_MODE ?? "normal";
const fixtureSessionId = "fixture-new-session";
const cancelledSessions = new Set();
const pendingCancellation = new Map();

function record(method, params) {
  process.stderr.write(`${JSON.stringify({ method, params })}\n`);
}

function configOptions(values = {}) {
  return [
    {
      type: "select",
      id: "alpha-model",
      name: "Model",
      category: "model",
      currentValue: values["alpha-model"] ?? "model-a",
      options: [
        { value: "model-a", name: "Model A" },
        { value: "model-b", name: "Model B" },
      ],
    },
    {
      type: "boolean",
      id: "zeta-enabled",
      name: "Enabled",
      currentValue: values["zeta-enabled"] ?? false,
    },
    {
      type: "select",
      id: "reasoning_effort",
      name: "Reasoning effort",
      currentValue: values.reasoning_effort ?? "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
    {
      type: "boolean",
      id: "omega-observer",
      name: "Observer",
      currentValue: values["omega-observer"] ?? false,
    },
  ];
}

const sessionConfigs = new Map();

function sessionConfig(sessionId) {
  let values = sessionConfigs.get(sessionId);
  if (!values) {
    values = {};
    sessionConfigs.set(sessionId, values);
  }
  return values;
}

async function notify(client, sessionId, update) {
  await client.notify(methods.client.session.update, { sessionId, update });
}

const app = agent({ name: "paperclip-acp-wire-fixture" });

app.onRequest(methods.agent.initialize, ({ params }) => {
  record(methods.agent.initialize, params);
  if (params.protocolVersion !== PROTOCOL_VERSION) {
    throw RequestError.invalidParams(
      { protocolVersion: params.protocolVersion },
      "fixture requires the stable wire version",
    );
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      sessionCapabilities: {
        additionalDirectories: {},
        resume: {},
      },
    },
    agentInfo: { name: "paperclip-acp-wire-fixture", version: "1" },
  };
});

app.onRequest(methods.agent.session.new, async ({ params, client }) => {
  record(methods.agent.session.new, params);
  sessionConfig(fixtureSessionId);
  if (fixtureMode === "early-setup-controls") {
    await notify(client, fixtureSessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: "normal",
    });
    await notify(client, fixtureSessionId, {
      sessionUpdate: "available_commands_update",
      availableCommands: [],
    });
  }
  return {
    sessionId: fixtureSessionId,
    configOptions: configOptions(sessionConfig(fixtureSessionId)),
  };
});

app.onRequest(methods.agent.session.resume, async ({ params, client }) => {
  record(methods.agent.session.resume, params);
  if (fixtureMode === "target-not-found") {
    throw RequestError.resourceNotFound(params.sessionId);
  }
  if (fixtureMode === "resume-error") {
    throw RequestError.internalError(
      { sessionId: params.sessionId },
      "fixture resume failed",
    );
  }
  sessionConfig(params.sessionId);
  if (fixtureMode === "early-setup-controls") {
    await notify(client, params.sessionId, {
      sessionUpdate: "session_info_update",
      title: "resumed-before-response",
    });
  }
  return {
    configOptions: configOptions(sessionConfig(params.sessionId)),
  };
});

app.onRequest(
  methods.agent.session.setConfigOption,
  ({ params }) => {
    record(methods.agent.session.setConfigOption, params);
    const values = sessionConfig(params.sessionId);
    values[params.configId] = params.value;
    const responseOptions = configOptions(values);
    if (fixtureMode === "config-option-removed") {
      return {
        configOptions: responseOptions.filter(
          (option) => option.id !== "omega-observer",
        ),
      };
    }
    if (fixtureMode === "config-type-drift") {
      return {
        configOptions: responseOptions.map((option) =>
          option.id === "zeta-enabled"
            ? {
                type: "select",
                id: option.id,
                name: option.name,
                currentValue: "enabled",
                options: [
                  { value: "disabled", name: "Disabled" },
                  { value: "enabled", name: "Enabled" },
                ],
              }
            : option,
        ),
      };
    }
    if (fixtureMode === "config-legal-values-drift") {
      return {
        configOptions: responseOptions.map((option) =>
          option.id === "alpha-model" && option.type === "select"
            ? {
                ...option,
                options: option.options.filter(
                  (candidate) =>
                    "group" in candidate || candidate.value !== "model-a",
                ),
              }
            : option,
        ),
      };
    }
    if (fixtureMode === "config-unrequested-current-drift") {
      return {
        configOptions: responseOptions.map((option) =>
          option.id === "omega-observer"
            ? { ...option, currentValue: true }
            : option,
        ),
      };
    }
    return { configOptions: responseOptions };
  },
);

app.onRequest(
  methods.agent.session.prompt,
  async ({ params, client }) => {
    record(methods.agent.session.prompt, params);
    const text =
      params.prompt.length === 1 && params.prompt[0]?.type === "text"
        ? params.prompt[0].text
        : null;
    if (text === null) {
      throw RequestError.invalidParams(
        { prompt: params.prompt },
        "fixture requires exactly one text block",
      );
    }

    await notify(client, params.sessionId, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "fixture thinking" },
    });

    if (text === "wait-for-cancel") {
      if (!cancelledSessions.has(params.sessionId)) {
        await new Promise((resolve) => {
          pendingCancellation.set(params.sessionId, resolve);
        });
      }
      await notify(client, params.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "fixture cancelled" },
      });
      await notify(client, params.sessionId, {
        sessionUpdate: "usage_update",
        used: 3,
        size: 128,
      });
      return { stopReason: "cancelled" };
    }

    await notify(client, params.sessionId, {
      sessionUpdate: "plan",
      entries: [
        {
          content: "exercise the wire",
          priority: "high",
          status: "in_progress",
        },
      ],
    });
    await notify(client, params.sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "fixture-tool",
      title: "Fixture tool",
      kind: "other",
      status: "in_progress",
      rawInput: { text },
    });
    await notify(client, params.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "fixture-tool",
      status: "completed",
      rawOutput: { ok: true },
    });
    await notify(client, params.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `fixture:${text}` },
    });
    if (fixtureMode === "missing-usage") {
      return { stopReason: "end_turn" };
    }
    await notify(client, params.sessionId, {
      sessionUpdate: "usage_update",
      used: 9,
      size: 128,
    });
    return { stopReason: "end_turn" };
  },
);

app.onNotification(methods.agent.session.cancel, ({ params }) => {
  record(methods.agent.session.cancel, params);
  cancelledSessions.add(params.sessionId);
  if (fixtureMode === "ignore-cancel") return;
  pendingCancellation.get(params.sessionId)?.();
  pendingCancellation.delete(params.sessionId);
});

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const connection = app.connect(ndJsonStream(output, input));

await connection.closed;
