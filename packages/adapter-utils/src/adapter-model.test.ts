import { describe, expect, it } from "vitest";
import { requireAdapterModel, validateAdapterModel } from "./adapter-model.js";

describe("adapter model", () => {
  it("accepts only the exact ACPX value and display label", () => {
    expect(validateAdapterModel({ value: "model-a", label: "Model A" })).toEqual({
      value: "model-a",
      label: "Model A",
    });
    expect(() =>
      validateAdapterModel({ value: "model-a", label: "Model A", limits: null }),
    ).toThrow(/unknown field limits/);
  });

  it("requires one exact advertised model value", () => {
    const models = [{ value: "model-a", label: "Model A" }];
    expect(requireAdapterModel({
      adapterType: "fixture",
      selection: "model-a",
      models,
    })).toEqual(models[0]);
    expect(() => requireAdapterModel({
      adapterType: "fixture",
      selection: "Model-A",
      models,
    })).toThrow(/not one exact advertised value/);
  });
});
