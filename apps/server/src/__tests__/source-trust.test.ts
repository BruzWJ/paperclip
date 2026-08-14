import { describe, expect, it } from "vitest";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { buildPromotedSourceTrust, isLowTrustQuarantined } from "../services/source-trust.js";

describe("source trust helpers", () => {
  it("builds distinct promoted source-trust metadata for trusted artifacts", () => {
    const promoted = buildPromotedSourceTrust({
      sourceTaskId: "11111111-1111-4111-8111-111111111111",
      sourceArtifactKind: "comment",
      sourceArtifactId: "44444444-4444-4444-8444-444444444444",
      promotedByActorType: "user",
      promotedByActorId: "board-user",
      promotedAt: new Date("2026-06-03T12:00:00.000Z"),
    });

    expect(
      isLowTrustQuarantined({
        preset: LOW_TRUST_REVIEW_PRESET,
        disposition: "quarantined",
        sourceTaskId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBe(true);
    expect(promoted).toEqual({
      preset: LOW_TRUST_REVIEW_PRESET,
      disposition: "promoted",
      sourceTaskId: "11111111-1111-4111-8111-111111111111",
      promotedFrom: {
        artifactKind: "comment",
        artifactId: "44444444-4444-4444-8444-444444444444",
        taskId: "11111111-1111-4111-8111-111111111111",
      },
      promotedByActorType: "user",
      promotedByActorId: "board-user",
      promotedAt: "2026-06-03T12:00:00.000Z",
    });
    expect(isLowTrustQuarantined(promoted)).toBe(false);
  });
});
