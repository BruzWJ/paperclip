import { describe, expect, it } from "vitest";
import { buildAgentOnboardingPrompt } from "./agent-onboarding-prompt";

describe("buildAgentOnboardingPrompt", () => {
  it("describes the provider-neutral Session onboarding contract", () => {
    const prompt = buildAgentOnboardingPrompt({
      onboardingTextUrl: "http://localhost:3100/api/invites/token-123/onboarding.txt",
    });

    expect(prompt).toContain(
      "Use this exact Paperclip onboarding document:\nhttp://localhost:3100/api/invites/token-123/onboarding.txt",
    );
    expect(prompt).toContain("agent-configuration proposal");
    expect(prompt).toContain("run-scoped compiled tool interface");
    expect(prompt).not.toContain("candidate");
    expect(prompt).not.toContain("test-resolution");
    expect(prompt).not.toContain("allowed-hostname");
    expect(prompt).not.toContain("PAPERCLIP_API_KEY");
    expect(prompt).not.toContain("PAPERCLIP_API_URL");
  });
});
// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: PAPERCLIP_API_KEY, PAPERCLIP_API_URL
