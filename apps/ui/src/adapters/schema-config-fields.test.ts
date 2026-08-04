import { describe, expect, it } from "vitest";
import type { AdapterConfigSchema, ConfigFieldSchema } from "@paperclipai/adapter-utils";
import {
  fieldMatchesVisibleWhen,
  missingRequiredAdapterConfigFields,
} from "./schema-config-fields";

const sourceField: ConfigFieldSchema = {
  key: "mode",
  label: "Mode",
  type: "select",
  options: [
    { label: "Fast", value: "fast" },
    { label: "Precise", value: "precise" },
  ],
};

const schema: AdapterConfigSchema = {
  fields: [sourceField],
};

function targetWithVisibleWhen(visibleWhen: Record<string, unknown>): ConfigFieldSchema {
  return {
    key: "model",
    label: "Model",
    type: "text",
    meta: { visibleWhen },
  };
}

describe("fieldMatchesVisibleWhen", () => {
  it("treats an empty values array as no match", () => {
    const field = targetWithVisibleWhen({ key: "mode", values: [] });

    expect(fieldMatchesVisibleWhen(field, () => "fast", schema)).toBe(false);
  });

  it("treats all non-string values as no match", () => {
    const field = targetWithVisibleWhen({ key: "mode", values: [null, 42] });

    expect(fieldMatchesVisibleWhen(field, () => "fast", schema)).toBe(false);
  });

  it("matches non-empty string values", () => {
    const field = targetWithVisibleWhen({ key: "mode", values: ["fast"] });

    expect(fieldMatchesVisibleWhen(field, () => "fast", schema)).toBe(true);
    expect(fieldMatchesVisibleWhen(field, () => "precise", schema)).toBe(false);
  });
});

describe("missingRequiredAdapterConfigFields", () => {
  it("requires an explicit stored value even when the schema advertises a default", () => {
    const engine: ConfigFieldSchema = {
      key: "engine",
      label: "Execution engine",
      type: "select",
      required: true,
      default: "acp",
      options: [
        { label: "ACP", value: "acp" },
        { label: "CLI", value: "cli" },
      ],
    };

    expect(
      missingRequiredAdapterConfigFields({ fields: [engine] }, {}),
    ).toEqual([engine]);
    expect(
      missingRequiredAdapterConfigFields(
        { fields: [engine] },
        { engine: "cli" },
      ),
    ).toEqual([]);
  });

  it("does not require a conditionally hidden field", () => {
    const field: ConfigFieldSchema = {
      ...targetWithVisibleWhen({ key: "mode", values: ["fast"] }),
      required: true,
    };
    const conditionalSchema: AdapterConfigSchema = {
      fields: [sourceField, field],
    };

    expect(
      missingRequiredAdapterConfigFields(
        conditionalSchema,
        { mode: "precise" },
      ),
    ).toEqual([]);
  });
});
