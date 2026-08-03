import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findUIAdapter,
  getUIAdapter,
  listUIAdapters,
  syncServerAdapters,
} from "./registry";
import { SchemaConfigFields } from "./schema-config-fields";

describe("server-admitted UI adapter catalog", () => {
  beforeEach(() => {
    syncServerAdapters([{ type: "codex", label: "Codex" }]);
  });

  afterEach(() => {
    syncServerAdapters([{ type: "codex", label: "Codex" }]);
  });

  it("publishes only exact entries supplied by the server catalog", () => {
    expect(listUIAdapters().map((adapter) => adapter.type)).toEqual(["codex"]);
    expect(findUIAdapter("codex")).toMatchObject({
      type: "codex",
      label: "Codex",
      ConfigFields: SchemaConfigFields,
    });
  });

  it("fails closed for unknown, whitespace, and case variants", () => {
    expect(findUIAdapter("unknown")).toBeNull();
    expect(() => getUIAdapter("unknown")).toThrow("not in the server-admitted ACP catalog");
    expect(() => getUIAdapter(" codex")).toThrow("not in the server-admitted ACP catalog");
    expect(() => getUIAdapter("Codex")).toThrow("not in the server-admitted ACP catalog");
  });

  it("removes an entry when it is absent from the next server snapshot", () => {
    syncServerAdapters([]);

    expect(listUIAdapters()).toEqual([]);
    expect(() => getUIAdapter("codex")).toThrow("not in the server-admitted ACP catalog");
  });

  it("rejects malformed and duplicate server entries", () => {
    expect(() =>
      syncServerAdapters([{ type: " codex", label: "Codex" }]),
    ).toThrow("invalid ACP adapter catalog");
    expect(() =>
      syncServerAdapters([{ type: "codex", label: "" }]),
    ).toThrow("invalid ACP adapter catalog");
    expect(() =>
      syncServerAdapters([{ type: "codex", label: " Codex" }]),
    ).toThrow("invalid ACP adapter catalog");
    expect(() =>
      syncServerAdapters([
        { type: "codex", label: "Codex" },
        { type: "codex", label: "Duplicate" },
      ]),
    ).toThrow("invalid ACP adapter catalog");
  });
});
