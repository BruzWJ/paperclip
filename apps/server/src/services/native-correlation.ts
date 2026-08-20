import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
  createAcpSessionCorrelation,
  parseAcpSessionCorrelation,
  type AcpSessionCorrelation,
  type AcpSessionStart,
} from "@paperclipai/adapter-utils/acpx-runtime";

export interface AcpCorrelationScope {
  readonly companyId: string;
  readonly taskId: string;
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly adapterConfigIdentity: string;
  readonly workspaceIdentity: string;
  readonly targetFingerprint: string;
  readonly correlationGeneration: number;
  readonly laneKind: "owner" | "consult";
  readonly authorizedContextExposureDigest: string;
}

export interface ProtectedAcpSessionCorrelation {
  readonly envelopeVersion: typeof ACP_SESSION_CORRELATION_ENVELOPE_VERSION;
  readonly codecKind: typeof ACP_SESSION_CORRELATION_KIND;
  readonly ciphertext: string;
  readonly digest: string;
}

/**
 * Exact eligible row selected under the canonical task/run locks. Plaintext
 * ACP ids are never part of this repository boundary.
 */
export interface StoredAcpSessionCorrelation extends ProtectedAcpSessionCorrelation {
  readonly id: string;
  readonly state: "eligible";
  readonly scope: AcpCorrelationScope;
}

export interface AcpSessionCorrelationProtector {
  seal(
    correlation: AcpSessionCorrelation,
    scope: AcpCorrelationScope,
  ): Promise<ProtectedAcpSessionCorrelation>;
  open(protectedCorrelation: ProtectedAcpSessionCorrelation, scope: AcpCorrelationScope): Promise<unknown>;
}

export interface ResolvedAcpSessionResume {
  readonly kind: "resume";
  readonly correlationId: string;
  readonly correlationGeneration: number;
  readonly start: Extract<AcpSessionStart, { kind: "resume" }>;
}

export class NativeCorrelationRejected extends Error {
  readonly code = "native_correlation_rejected";

  constructor(message: string) {
    super(message);
    this.name = "NativeCorrelationRejected";
  }
}

function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new NativeCorrelationRejected(`${label} must be exact and non-empty`);
  }
}

function exactDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new NativeCorrelationRejected(`${label} must be a SHA-256 digest`);
  }
}

export function validateAcpCorrelationScope(scope: AcpCorrelationScope): void {
  exactIdentity(scope.companyId, "correlation company id");
  exactIdentity(scope.taskId, "correlation task id");
  exactIdentity(scope.targetAgentId, "correlation target agent id");
  exactIdentity(scope.adapterConfigIdentity, "correlation adapter revision identity");
  exactIdentity(scope.workspaceIdentity, "correlation workspace identity");
  exactDigest(scope.targetFingerprint, "correlation target fingerprint");
  if (
    !Number.isSafeInteger(scope.ownershipEpoch) ||
    scope.ownershipEpoch < 1 ||
    !Number.isSafeInteger(scope.correlationGeneration) ||
    scope.correlationGeneration < 1
  ) {
    throw new NativeCorrelationRejected("correlation epoch and generation must be positive integers");
  }
  exactDigest(scope.authorizedContextExposureDigest, "correlation context exposure digest");
}

function validateStoredCorrelation(stored: StoredAcpSessionCorrelation): void {
  exactIdentity(stored.id, "stored correlation id");
  validateAcpCorrelationScope(stored.scope);
  if (
    stored.envelopeVersion !== ACP_SESSION_CORRELATION_ENVELOPE_VERSION ||
    stored.codecKind !== ACP_SESSION_CORRELATION_KIND ||
    stored.state !== "eligible"
  ) {
    throw new NativeCorrelationRejected("stored ACP correlation is not eligible");
  }
  exactIdentity(stored.ciphertext, "stored correlation ciphertext");
  exactDigest(stored.digest, "stored correlation digest");
}

export function createNativeCorrelationService(options: {
  readonly protector: AcpSessionCorrelationProtector;
}) {
  return {
    /** Opens the exact eligible encrypted row for one frozen resume. */
    async resolveResume(input: {
      readonly stored: StoredAcpSessionCorrelation | null;
    }): Promise<ResolvedAcpSessionResume> {
      if (!input.stored) {
        throw new NativeCorrelationRejected("frozen ACP resume operation lost its exact stored correlation");
      }
      validateStoredCorrelation(input.stored);
      const raw = await options.protector.open(input.stored, input.stored.scope);
      let parsed: AcpSessionCorrelation;
      try {
        parsed = parseAcpSessionCorrelation(raw);
      } catch {
        throw new NativeCorrelationRejected("stored ACP correlation envelope is malformed");
      }
      return {
        kind: "resume",
        correlationId: input.stored.id,
        correlationGeneration: input.stored.scope.correlationGeneration,
        start: {
          kind: "resume",
          sessionId: parsed.payload.sessionId,
        },
      };
    },

    /** Seals a setup result for the one authorized persistence purpose. */
    async protectSession(input: {
      readonly sessionId: string;
      readonly scope: AcpCorrelationScope;
    }): Promise<ProtectedAcpSessionCorrelation> {
      validateAcpCorrelationScope(input.scope);
      return options.protector.seal(createAcpSessionCorrelation(input.sessionId), input.scope);
    },
  };
}

export type NativeCorrelationService = ReturnType<typeof createNativeCorrelationService>;
