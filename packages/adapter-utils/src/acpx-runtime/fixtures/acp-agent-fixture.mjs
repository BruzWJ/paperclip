import { Readable, Writable } from "node:stream";
import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  ndJsonStream,
} from "@agentclientprotocol/sdk";

const fixtureSessionId = "fixture-new-session";

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

app.onRequest(methods.agent.session.new, ({ params }) => {
  record(methods.agent.session.new, params);
  sessionConfig(fixtureSessionId);
  return {
    sessionId: fixtureSessionId,
    configOptions: configOptions(sessionConfig(fixtureSessionId)),
  };
});

app.onRequest(
  methods.agent.session.setConfigOption,
  ({ params }) => {
    record(methods.agent.session.setConfigOption, params);
    const values = sessionConfig(params.sessionId);
    values[params.configId] = params.value;
    return { configOptions: configOptions(values) };
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
    await notify(client, params.sessionId, {
      sessionUpdate: "usage_update",
      used: 9,
      size: 128,
    });
    return { stopReason: "end_turn" };
  },
);

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const connection = app.connect(ndJsonStream(output, input));

await connection.closed;
