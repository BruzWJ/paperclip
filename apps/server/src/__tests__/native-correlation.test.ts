import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
  createAcpSessionCorrelation,
} from "@paperclipai/adapter-utils/acpx-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  NativeCorrelationRejected,
  createNativeCorrelationService,
  type AcpCorrelationScope,
  type StoredAcpSessionCorrelation,
} from "../services/native-correlation.js";

const digest = "a".repeat(64);
const scope: AcpCorrelationScope = {
  companyId: "company-1",
  taskId: "task-1",
  ownershipEpoch: 2,
  targetAgentId: "agent-1",
  adapterConfigIdentity: "revision-1",
  workspaceIdentity: "workspace-1",
  targetFingerprint: "b".repeat(64),
  correlationGeneration: 3,
  laneKind: "owner",
  authorizedContextExposureDigest: digest,
};

function stored(): StoredAcpSessionCorrelation {
  return {
    id: "correlation-1",
    state: "eligible",
    scope,
    envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
    codecKind: ACP_SESSION_CORRELATION_KIND,
    ciphertext: "pcnc.v1.nonce.tag.ciphertext",
    digest,
  };
}

function harness() {
  const open = vi.fn(async () => createAcpSessionCorrelation("opaque-acp-session"));
  const seal = vi.fn(async () => ({
    envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
    codecKind: ACP_SESSION_CORRELATION_KIND,
    ciphertext: "pcnc.v1.encrypted",
    digest,
  }));
  return {
    open,
    seal,
    service: createNativeCorrelationService({ protector: { open, seal } }),
  };
}

describe("fixed ACP session correlation", () => {
  it("resumes the exact eligible encrypted mapping", async () => {
    const { service } = harness();
    await expect(service.resolveResume({ stored: stored() })).resolves.toEqual({
      kind: "resume",
      correlationId: "correlation-1",
      correlationGeneration: 3,
      start: { kind: "resume", sessionId: "opaque-acp-session" },
    });
  });

  it("rejects a missing or malformed frozen mapping", async () => {
    const { service } = harness();
    await expect(service.resolveResume({ stored: null })).rejects.toThrow(
      "frozen ACP resume operation lost its exact stored correlation",
    );
    await expect(
      service.resolveResume({ stored: { ...stored(), codecKind: "adapter-thread/v1" as never } }),
    ).rejects.toBeInstanceOf(NativeCorrelationRejected);
  });

  it("seals only the fixed ACP envelope under the exact retention scope", async () => {
    const { service, seal } = harness();
    await expect(service.protectSession({ sessionId: "new-opaque-session", scope })).resolves.toMatchObject({
      envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
      codecKind: ACP_SESSION_CORRELATION_KIND,
    });
    expect(seal).toHaveBeenCalledWith(createAcpSessionCorrelation("new-opaque-session"), scope);
  });
});
