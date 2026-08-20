import { createAcpSessionCorrelation } from "@paperclipai/adapter-utils/acpx-runtime";
import { describe, expect, it } from "vitest";
import { createAuthenticatedNativeCorrelationProtector } from "../services/native-correlation-postgres.js";
import {
  NativeCorrelationRejected,
  type AcpCorrelationScope,
} from "../services/native-correlation.js";

const secret = "test-only-native-correlation-secret-material-0000000000000000";
const scope: AcpCorrelationScope = {
  companyId: "company-1",
  taskId: "task-1",
  ownershipEpoch: 2,
  targetAgentId: "agent-1",
  adapterConfigIdentity: "revision-1",
  workspaceIdentity: "workspace-1",
  laneKind: "owner",
  authorizedContextExposureDigest: "a".repeat(64),
  targetFingerprint: "b".repeat(64),
  correlationGeneration: 4,
};

describe("authenticated ACP-correlation protection", () => {
  it("round-trips the fixed envelope without exposing its session id", async () => {
    const protector = createAuthenticatedNativeCorrelationProtector({
      secret,
      random: () => Buffer.alloc(12, 7),
    });
    const envelope = createAcpSessionCorrelation("opaque-acp-session-secret");
    const sealed = await protector.seal(envelope, scope);

    expect(sealed.ciphertext).toMatch(/^pcnc\.v1\./);
    expect(sealed.ciphertext).not.toContain("opaque-acp-session-secret");
    expect(sealed.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(protector.open(sealed, scope)).resolves.toEqual(envelope);
  });

  it("rejects ciphertext, digest, secret, and scope transplantation", async () => {
    const protector = createAuthenticatedNativeCorrelationProtector({
      secret,
      random: () => Buffer.alloc(12, 3),
    });
    const other = createAuthenticatedNativeCorrelationProtector({
      secret: "different-test-native-correlation-secret-00000000000000000",
    });
    const sealed = await protector.seal(createAcpSessionCorrelation("opaque"), scope);
    const final = sealed.ciphertext.at(-1);
    const tampered = {
      ...sealed,
      ciphertext: `${sealed.ciphertext.slice(0, -1)}${final === "A" ? "B" : "A"}`,
    };

    await expect(protector.open(tampered, scope)).rejects.toBeInstanceOf(NativeCorrelationRejected);
    await expect(protector.open({ ...sealed, digest: "f".repeat(64) }, scope)).rejects.toBeInstanceOf(
      NativeCorrelationRejected,
    );
    await expect(other.open(sealed, scope)).rejects.toBeInstanceOf(NativeCorrelationRejected);
    await expect(
      protector.open(sealed, { ...scope, ownershipEpoch: scope.ownershipEpoch + 1 }),
    ).rejects.toBeInstanceOf(NativeCorrelationRejected);
  });
});
