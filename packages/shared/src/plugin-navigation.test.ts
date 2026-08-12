import { describe, expect, it } from "vitest";
import {
  isCanonicalPluginNavigationTarget,
  resolvePluginNavigationHref,
} from "./plugin-navigation.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

describe("plugin navigation", () => {
  it("resolves the exact company-relative path grammar", () => {
    expect(isCanonicalPluginNavigationTarget("/wiki")).toBe(true);
    expect(
      isCanonicalPluginNavigationTarget(
        "/wiki/page/templates?tab=browse#section",
      ),
    ).toBe(true);
    expect(
      resolvePluginNavigationHref("/wiki?tab=browse#section", COMPANY_ID),
    ).toBe(`/${COMPANY_ID}/wiki?tab=browse#section`);
  });

  it.each([
    "wiki",
    ".",
    "./wiki",
    "../wiki",
    "?tab=browse",
    "#section",
    "/",
    "/wiki/",
    "/wiki//page",
    "/wiki/./page",
    "/wiki/../page",
    "/wiki/%2e/page",
    "/wiki/%2Fpage",
    "/%77iki",
    "//example.com/wiki",
    "https://example.com/wiki",
    `/${COMPANY_ID}/wiki`,
  ])("rejects noncanonical target %s", (target) => {
    expect(isCanonicalPluginNavigationTarget(target)).toBe(false);
    expect(() => resolvePluginNavigationHref(target, COMPANY_ID)).toThrow(
      "absolute company-relative path",
    );
  });

  it("requires the active canonical company UUID", () => {
    expect(() => resolvePluginNavigationHref("/wiki", "paperclip")).toThrow(
      "requires a canonical company UUID",
    );
  });
});
