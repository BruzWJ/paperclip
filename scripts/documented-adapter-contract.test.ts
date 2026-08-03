import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveAcpAdapterRevisionConfiguration,
  validateServerAdapterModule,
} from "../packages/adapter-utils/src/index.ts";
import {
  createServerAdapter,
} from "../docs/adapters/examples/canonical-server-adapter.ts";

describe("documented canonical server adapter", () => {
  it("is only one closed declarative ACP subprocess definition", () => {
    const adapter = createServerAdapter();

    assert.equal(validateServerAdapterModule(adapter), adapter);
    assert.deepEqual(Object.keys(adapter).sort(), ["definition", "type"]);
    assert.equal(adapter.definition.version, "acp-subprocess/v1");
    assert.equal(adapter.definition.launchProfile.registryName, "codex");
  });

  it("resolves exact non-secret ACP configuration and immutable limits", () => {
    const revision = resolveAcpAdapterRevisionConfiguration({
      adapter: createServerAdapter(),
      config: { model: "gpt-5.6" },
    });

    assert.deepEqual(revision.sessionConfigSelections, [
      { configId: "model", value: "gpt-5.6" },
    ]);
    assert.deepEqual(revision.model.limits, {
      contextTokenLimit: 1_050_000,
      inputTokenLimit: 922_000,
      outputTokenLimit: 128_000,
    });
  });

  it("has no executable, parser, prompt, credential, or session callback", () => {
    const serialized = JSON.stringify(createServerAdapter());

    // PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: testEnvironment, onHireApproved
    for (const forbidden of [
      "execute",
      "streamStatelessTurn",
      "parseStdoutLine",
      "providerInputKind",
      "nativeCorrelationCodec",
      "testEnvironment",
      "onHireApproved",
    ]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  });
});
