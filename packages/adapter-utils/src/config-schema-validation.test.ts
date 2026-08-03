import { describe, expect, it } from "vitest";
import { validateAdapterConfigSchema } from "./config-schema-validation.js";

describe("validateAdapterConfigSchema", () => {
  it("accepts a complete schema with typed defaults and visibility metadata", () => {
    const schema = {
      fields: [
        {
          key: "lane",
          label: "Runtime lane",
          type: "select",
          required: true,
          options: [
            { value: "native", label: "Native" },
            { value: "stateless", label: "Stateless" },
          ],
          default: "stateless",
        },
        {
          key: "model",
          label: "Model",
          type: "text",
          meta: {
            visibleWhen: {
              key: "lane",
              values: ["native"],
            },
          },
        },
      ],
    };

    expect(validateAdapterConfigSchema(schema)).toEqual({
      success: true,
      data: schema,
    });
  });

  it.each([
    [
      "unsupported types",
      {
        fields: [{ key: "model", label: "Model", type: "password" }],
      },
      "unsupported type",
    ],
    [
      "malformed required",
      {
        fields: [
          {
            key: "model",
            label: "Model",
            type: "text",
            required: "yes",
          },
        ],
      },
      "required must be a boolean",
    ],
    [
      "malformed options",
      {
        fields: [
          {
            key: "lane",
            label: "Lane",
            type: "select",
            options: [{ value: "native", label: "" }],
          },
        ],
      },
      "label must be a non-empty string",
    ],
    [
      "empty labels",
      {
        fields: [{ key: "model", label: " ", type: "text" }],
      },
      "label must be a non-empty string",
    ],
    [
      "duplicate fields",
      {
        fields: [
          { key: "model", label: "Primary", type: "text" },
          { key: "model", label: "Secondary", type: "text" },
        ],
      },
      "is duplicated",
    ],
  ])("rejects %s", (_name, schema, expectedError) => {
    const result = validateAdapterConfigSchema(schema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.join(" ")).toContain(expectedError);
    }
  });

});
