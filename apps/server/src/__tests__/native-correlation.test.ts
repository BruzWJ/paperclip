import { describe, expect, it, vi } from "vitest";
import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
  createAcpSessionCorrelation,
} from "@paperclipai/adapter-utils/acpx-runtime";
import {
  NativeCorrelationRejected,
  createNativeCorrelationService,
  type AcpCorrelationScope,
  type StoredAcpSessionCorrelation,
} from "../services/native-correlation.js";

const digest = "a".repeat(64);

function scope(
  purpose: "carry" | "active_run_steering",
): AcpCorrelationScope {
  const common = {
    companyId: "company-1",
    issueId: "issue-1",
    ownershipEpoch: 2,
    targetAgentId: "agent-1",
    adapterConfigIdentity: "revision-1",
    workspaceIdentity: "workspace-1",
    targetFingerprint: "b".repeat(64),
    correlationGeneration: 3,
  } as const;
  return purpose === "carry"
    ? {
        ...common,
        purpose,
        laneKind: "owner",
        authorizedContextExposureDigest: digest,
      }
    : {
        ...common,
        purpose,
        runId: "run-1",
        currentRefId: "ref-1",
        currentRefOrdinal: 0,
        currentSegmentOrdinal: 1,
      };
}

function stored(
  purpose: "carry" | "active_run_steering",
): StoredAcpSessionCorrelation {
  return {
    id: "correlation-1",
    state: purpose === "carry" ? "eligible" : "current",
    scope: scope(purpose),
    envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
    codecKind: ACP_SESSION_CORRELATION_KIND,
    ciphertext: "pcnc.v1.nonce.tag.ciphertext",
    digest,
  };
}

function harness() {
  const open = vi.fn(async () =>
    createAcpSessionCorrelation("opaque-acp-session"));
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
  it("rejects a false-carry base resume without reading correlation", async () => {
    const { service, open } = harness();
    await expect(service.resolveResume({
      promptKind: "base",
      carryContext: false,
      bootstrapHandoff: false,
      stored: null,
    })).rejects.toThrow("false-carry base prompt cannot resolve an ACP resume");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a forbidden lookup supplied to a false-carry base", async () => {
    const { service } = harness();
    await expect(service.resolveResume({
      promptKind: "base",
      carryContext: false,
      bootstrapHandoff: false,
      stored: stored("active_run_steering"),
    })).rejects.toBeInstanceOf(NativeCorrelationRejected);
  });

  it("resumes an exact bootstrap handoff for a false-carry base", async () => {
    const { service } = harness();
    await expect(service.resolveResume({
      promptKind: "base",
      carryContext: false,
      bootstrapHandoff: true,
      stored: stored("active_run_steering"),
    })).resolves.toMatchObject({
      kind: "resume",
      start: { sessionId: "opaque-acp-session" },
    });
  });

  it("resumes only carry for true carry and steering-only for false steering", async () => {
    const { service } = harness();
    await expect(service.resolveResume({
      promptKind: "base",
      carryContext: true,
      bootstrapHandoff: false,
      stored: stored("carry"),
    })).resolves.toEqual({
      kind: "resume",
      correlationId: "correlation-1",
      correlationGeneration: 3,
      start: { kind: "resume", sessionId: "opaque-acp-session" },
    });
    await expect(service.resolveResume({
      promptKind: "steering",
      carryContext: false,
      bootstrapHandoff: false,
      stored: stored("active_run_steering"),
    })).resolves.toMatchObject({
      kind: "resume",
      start: { sessionId: "opaque-acp-session" },
    });
  });

  it("rejects every frozen resume that lost its exact stored mapping", async () => {
    const { service } = harness();
    await expect(service.resolveResume({
      promptKind: "base",
      carryContext: true,
      bootstrapHandoff: false,
      stored: null,
    })).rejects.toThrow(
      "frozen ACP resume operation lost its exact stored correlation",
    );
    await expect(service.resolveResume({
      promptKind: "steering",
      carryContext: false,
      bootstrapHandoff: false,
      stored: null,
    })).rejects.toBeInstanceOf(NativeCorrelationRejected);
  });

  it("rejects cross-purpose rows and malformed fixed envelopes", async () => {
    const { service } = harness();
    await expect(service.resolveResume({
      promptKind: "base",
      carryContext: true,
      bootstrapHandoff: false,
      stored: stored("active_run_steering"),
    })).rejects.toBeInstanceOf(NativeCorrelationRejected);
    await expect(service.resolveResume({
      promptKind: "base",
      carryContext: true,
      bootstrapHandoff: false,
      stored: {
        ...stored("carry"),
        codecKind: "adapter-thread/v1" as never,
      },
    })).rejects.toBeInstanceOf(NativeCorrelationRejected);
  });

  it("seals only the fixed ACP envelope under the exact retention scope", async () => {
    const { service, seal } = harness();
    const retentionScope = scope("carry");
    await expect(service.protectSession({
      sessionId: "new-opaque-session",
      scope: retentionScope,
    })).resolves.toMatchObject({
      envelopeVersion: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
      codecKind: ACP_SESSION_CORRELATION_KIND,
    });
    expect(seal).toHaveBeenCalledWith(
      createAcpSessionCorrelation("new-opaque-session"),
      retentionScope,
    );
  });
});
