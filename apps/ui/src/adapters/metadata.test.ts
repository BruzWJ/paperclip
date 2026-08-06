import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isEnabledAdapterType,
  isValidAdapterType,
  isVisualAdapterChoice,
  listAdapterOptions,
} from "./metadata";
import { syncServerAdapters } from "./registry";

describe("adapter metadata", () => {
  beforeEach(() => {
    syncServerAdapters([{ type: "codex", label: "Codex" }]);
  });

  afterEach(() => {
    syncServerAdapters([{ type: "codex", label: "Codex" }]);
  });

  it("exposes only the exact server-admitted local-agent catalog", () => {
    expect(isEnabledAdapterType("codex")).toBe(true);
    expect(isValidAdapterType("codex")).toBe(true);
    expect(isVisualAdapterChoice("codex")).toBe(true);
    expect(isValidAdapterType("unknown")).toBe(false);
    expect(isValidAdapterType("Codex")).toBe(false);

    expect(listAdapterOptions()).toEqual([
      {
        value: "codex",
        label: "Codex",
      },
    ]);
  });

  it("uses the exact server catalog label instead of static presentation metadata", () => {
    syncServerAdapters([{ type: "codex", label: "Pinned Codex Frontend" }]);

    expect(listAdapterOptions()).toEqual([
      {
        value: "codex",
        label: "Pinned Codex Frontend",
      },
    ]);
  });
});
