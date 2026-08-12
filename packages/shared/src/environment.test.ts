import { describe, expect, it } from "vitest";
import {
  parseOptionalBooleanEnvironmentValue,
  parseOptionalExactNonEmptyEnvironmentValue,
  parseOptionalEnumEnvironmentValue,
  parseOptionalIntegerEnvironmentValue,
} from "./environment.js";

describe("canonical environment values", () => {
  it("accepts only exact boolean spellings", () => {
    expect(
      parseOptionalBooleanEnvironmentValue(undefined, "FLAG"),
    ).toBeUndefined();
    expect(parseOptionalBooleanEnvironmentValue("true", "FLAG")).toBe(true);
    expect(parseOptionalBooleanEnvironmentValue("false", "FLAG")).toBe(false);
    for (const value of ["", "1", "0", "TRUE", " false "]) {
      expect(() => parseOptionalBooleanEnvironmentValue(value, "FLAG")).toThrow(
        /exactly "true" or "false"/,
      );
    }
  });

  it("accepts only exact enum members", () => {
    expect(
      parseOptionalEnumEnvironmentValue("lan", "PAPERCLIP_BIND", [
        "loopback",
        "lan",
      ] as const),
    ).toBe("lan");
    for (const value of ["", "LAN", " lan ", "public"]) {
      expect(() =>
        parseOptionalEnumEnvironmentValue(value, "PAPERCLIP_BIND", [
          "loopback",
          "lan",
        ] as const),
      ).toThrow(/PAPERCLIP_BIND/);
    }
  });

  it("accepts only exact bounded integers", () => {
    expect(
      parseOptionalIntegerEnvironmentValue("30000", "INTERVAL", {
        min: 10000,
      }),
    ).toBe(30000);
    for (const value of ["", "030000", " 30000", "1.5", "9999"]) {
      expect(() =>
        parseOptionalIntegerEnvironmentValue(value, "INTERVAL", {
          min: 10000,
        }),
      ).toThrow(/INTERVAL/);
    }
  });

  it("accepts only exact non-empty strings", () => {
    expect(
      parseOptionalExactNonEmptyEnvironmentValue(undefined, "HOST"),
    ).toBeUndefined();
    expect(
      parseOptionalExactNonEmptyEnvironmentValue("192.0.2.10", "HOST"),
    ).toBe("192.0.2.10");
    for (const value of ["", " ", " 192.0.2.10", "192.0.2.10 "]) {
      expect(() =>
        parseOptionalExactNonEmptyEnvironmentValue(value, "HOST"),
      ).toThrow(/HOST must be non-empty and contain no surrounding whitespace/);
    }
  });
});
