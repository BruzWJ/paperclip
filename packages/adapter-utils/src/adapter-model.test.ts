import { describe, expect, it } from "vitest";
import {
  sameAdapterModel,
  validateAdapterModel,
  validateAdapterModelLimits,
} from "./adapter-model.js";

const knownLimits = Object.freeze({
  contextTokenLimit: 128_000,
  inputTokenLimit: 96_000,
  outputTokenLimit: 32_000,
});

describe("ACP adapter model validation", () => {
  it("preserves a target's explicit unknown token limits", () => {
    const model = validateAdapterModel({
      id: "target-model",
      label: "Target model",
      value: "target-model",
      limits: null,
    });

    expect(model.limits).toBeNull();
    expect(() =>
      validateAdapterModel({
        id: "target-model",
        label: "Target model",
        value: "target-model",
      }),
    ).toThrow(/limits must be an object/);
  });

  it("retains strict validation and equality for known limits", () => {
    const known = validateAdapterModel({
      id: "target-model",
      label: "Target model",
      value: "target-model",
      limits: knownLimits,
    });
    const unknown = validateAdapterModel({
      id: "target-model",
      label: "Target model",
      value: "target-model",
      limits: null,
    });

    expect(validateAdapterModelLimits(knownLimits)).toEqual(knownLimits);
    expect(() =>
      validateAdapterModelLimits({
        ...knownLimits,
        outputTokenLimit: knownLimits.contextTokenLimit + 1,
      }),
    ).toThrow(/cannot exceed/);
    expect(sameAdapterModel(known, { ...known, limits: { ...knownLimits } })).toBe(
      true,
    );
    expect(sameAdapterModel(unknown, unknown)).toBe(true);
    expect(sameAdapterModel(known, unknown)).toBe(false);
  });
});
