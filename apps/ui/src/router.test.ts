import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createAppRouter } from "./router";

describe("application router contract", () => {
  it("uses one case-sensitive, slash-normalized client route surface", () => {
    const router = createAppRouter(new QueryClient());

    expect(router.options.caseSensitive).toBe(true);
    expect(router.options.trailingSlash).toBe("never");

    const fullPaths = new Set(
      Object.values(router.routesById).map((route) => route.fullPath),
    );
    for (const removedPath of [
      "/$companyId/agents/all",
      "/$companyId/approvals/pending",
      "/$companyId/inbox/mine",
      "/$companyId/projects/$projectId/overview",
      "/$companyId/company/onboarding",
      "/$companyId/company/settings/instance/general",
      "/performance",
      "/tests/perf/long-thread",
    ]) {
      expect(fullPaths.has(removedPath), removedPath).toBe(false);
    }
  });
});
