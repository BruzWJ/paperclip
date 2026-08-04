import { describe, expect, it } from "vitest";

import {
  getAdapterDisplay,
  getAdapterLabel,
  getAdapterLabels,
  isKnownAdapterType,
} from "./adapter-display-registry";

describe("adapter display registry", () => {
  it("does not maintain a local agent catalog", () => {
    expect(getAdapterLabels()).toEqual({});
    expect(isKnownAdapterType("codex")).toBe(false);
    expect(isKnownAdapterType("claude")).toBe(false);
    expect(isKnownAdapterType("fixture_acp")).toBe(false);
  });

  it("derives neutral presentation for a server-admitted catalog name", () => {
    expect(getAdapterLabel("fixture_acp")).toBe("Fixture Acp");
    expect(getAdapterDisplay("fixture_acp")).toMatchObject({
      label: "Fixture Acp",
      description: "Discovered from ACPX at runtime",
    });
  });
});
