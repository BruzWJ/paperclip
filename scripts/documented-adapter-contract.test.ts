import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const overview = await readFile(
  new URL("../docs/adapters/overview.md", import.meta.url),
  "utf8",
);
const discoveryGuide = await readFile(
  new URL("../docs/adapters/creating-an-adapter.md", import.meta.url),
  "utf8",
);
const externalAdapters = await readFile(
  new URL("../docs/adapters/external-adapters.md", import.meta.url),
  "utf8",
);

describe("documented ACPX adapter contract", () => {
  it("documents ACPX as the sole dynamic supplier", () => {
    for (const source of [overview, discoveryGuide, externalAdapters]) {
      assert.match(source, /ACPX/i);
      assert.doesNotMatch(source, /@agentclientprotocol\/codex-acp/);
      assert.doesNotMatch(source, /resolveApprovedAcpLaunch/);
    }
    assert.match(overview, /sole agent catalog supplier/i);
    assert.match(discoveryGuide, /does not accept hand-authored, built-in, or external adapter/i);
  });

  it("documents generic advertised configuration and runtime application", () => {
    for (const source of [overview, discoveryGuide, externalAdapters]) {
      assert.match(source, /reasoning/i);
      assert.match(source, /session\/set_config_option/i);
    }
    assert.match(discoveryGuide, /immutable ACP session configuration\s+selections/i);
  });
});
