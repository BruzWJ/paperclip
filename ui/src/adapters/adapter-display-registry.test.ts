import { describe, expect, it } from "vitest";

import {
  getAdapterDisplay,
  getAdapterLabel,
  getAdapterLabels,
  isKnownAdapterType,
} from "./adapter-display-registry";

describe("adapter display registry", () => {
  it("publishes display metadata only for the canonical ACP adapter", () => {
    expect(getAdapterLabel("codex")).toBe("Codex");

    expect(getAdapterLabels()).toEqual({
      codex: "Codex",
    });
    expect(isKnownAdapterType("codex")).toBe(true);
    expect(isKnownAdapterType("process")).toBe(false);
    expect(isKnownAdapterType("http")).toBe(false);
    expect(isKnownAdapterType("fixture_acp")).toBe(false);
  });

  it("derives neutral presentation for a server-admitted catalog name", () => {
    expect(getAdapterLabel("fixture_acp")).toBe("Fixture Acp");
    expect(getAdapterDisplay("fixture_acp")).toMatchObject({
      label: "Fixture Acp",
      description: "Server-admitted ACP frontend",
    });
  });
});
