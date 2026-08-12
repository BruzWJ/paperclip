import { describe, expect, it } from "vitest";
import { deriveAgentAdapterConfigRevision } from "./agent-adapter-config-revisions.js";

const FIXTURE_AGENT = "fixture-agent";

function acpConfiguration(model = "model-1") {
  return {
    contractVersion: "acpx-runtime/v1" as const,
    launchProfile: { registryName: FIXTURE_AGENT },
    sessionConfigSelections: [
      { configId: "model", value: model },
      { configId: "reasoning_effort", value: "high" },
    ],
    model: {
      value: model,
      label: model === "model-1" ? "Fixture model one" : "Fixture model two",
    },
  };
}

describe("canonical ACPX adapter configuration revision", () => {
  it("persists one immutable ACPX configuration and its digest", () => {
    const revision = deriveAgentAdapterConfigRevision({
      acpConfiguration: acpConfiguration(),
    });

    expect(revision).toEqual({
      acpConfiguration: acpConfiguration(),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.isFrozen(revision.acpConfiguration)).toBe(true);
    expect(Object.isFrozen(revision.acpConfiguration.sessionConfigSelections)).toBe(true);
  });

  it("derives a stable digest exclusively from immutable ACPX facts", () => {
    const first = deriveAgentAdapterConfigRevision({
      acpConfiguration: acpConfiguration(),
    });
    const same = deriveAgentAdapterConfigRevision({
      acpConfiguration: acpConfiguration(),
    });
    const changed = deriveAgentAdapterConfigRevision({
      acpConfiguration: acpConfiguration("model-2"),
    });

    expect(first.digest).toBe(same.digest);
    expect(changed.digest).not.toBe(first.digest);
  });

  it("rejects duplicate or unsorted ACPX session option ids", () => {
    expect(() =>
      deriveAgentAdapterConfigRevision({
        acpConfiguration: {
          ...acpConfiguration(),
          sessionConfigSelections: [
            { configId: "reasoning_effort", value: "high" },
            { configId: "model", value: "model-1" },
          ],
        },
      }),
    ).toThrow("Invalid immutable ACPX adapter configuration");
  });
});
