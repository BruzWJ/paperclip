import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
  createAcpSessionCorrelation,
  parseAcpSessionCorrelation,
  type AcpSessionCorrelation,
  type AcpSessionStart,
} from "@paperclipai/adapter-utils/acp-subprocess";

interface AcpCorrelationScopeBase {
  readonly companyId: string;
  readonly issueId: string;
  readonly ownershipEpoch: number;
  readonly targetAgentId: string;
  readonly adapterConfigIdentity: string;
  readonly workspaceIdentity: string;
  readonly targetFingerprint: string;
  readonly correlationGeneration: number;
}

export interface AcpCarryCorrelationScope extends AcpCorrelationScopeBase {
  readonly purpose: "carry";
  readonly laneKind: "owner" | "consult";
  readonly authorizedContextExposureDigest: string;
}

export interface AcpActiveRunSteeringCorrelationScope
  extends AcpCorrelationScopeBase {
  readonly purpose: "active_run_steering";
  readonly runId: string;
  readonly currentRefId: string;
  readonly currentRefOrdinal: number;
  readonly currentSegmentOrdinal: number;
}

export type AcpCorrelationScope =
  | AcpCarryCorrelationScope
  | AcpActiveRunSteeringCorrelationScope;

export interface ProtectedAcpSessionCorrelation {
  readonly envelopeVersion: typeof ACP_SESSION_CORRELATION_ENVELOPE_VERSION;
  readonly codecKind: typeof ACP_SESSION_CORRELATION_KIND;
  readonly ciphertext: string;
  readonly digest: string;
}

/**
 * Exact eligible row selected under the canonical issue/run locks. Plaintext
 * ACP ids are never part of this repository boundary.
 */
export interface StoredAcpSessionCorrelation
  extends ProtectedAcpSessionCorrelation {
  readonly id: string;
  readonly state: "eligible" | "current";
  readonly scope: AcpCorrelationScope;
}

export interface AcpSessionCorrelationProtector {
  seal(
    correlation: AcpSessionCorrelation,
    scope: AcpCorrelationScope,
  ): Promise<ProtectedAcpSessionCorrelation>;
  open(
    protectedCorrelation: ProtectedAcpSessionCorrelation,
    scope: AcpCorrelationScope,
  ): Promise<unknown>;
}

export type ResolvedAcpSessionStart =
  | { readonly kind: "new" }
  | {
      readonly kind: "resume";
      readonly correlationId: string;
      readonly correlationGeneration: number;
      readonly start: Extract<AcpSessionStart, { kind: "resume" }>;
    }
  | { readonly kind: "target_not_found" };

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

export function validateAcpCorrelationScope(
  scope: AcpCorrelationScope,
): void {
  exactIdentity(scope.companyId, "correlation company id");
  exactIdentity(scope.issueId, "correlation issue id");
  exactIdentity(scope.targetAgentId, "correlation target agent id");
  exactIdentity(
    scope.adapterConfigIdentity,
    "correlation adapter revision identity",
  );
  exactIdentity(scope.workspaceIdentity, "correlation workspace identity");
  exactDigest(scope.targetFingerprint, "correlation target fingerprint");
  if (
    !Number.isSafeInteger(scope.ownershipEpoch) ||
    scope.ownershipEpoch < 1 ||
    !Number.isSafeInteger(scope.correlationGeneration) ||
    scope.correlationGeneration < 1
  ) {
    throw new NativeCorrelationRejected(
      "correlation epoch and generation must be positive integers",
    );
  }
  if (scope.purpose === "carry") {
    exactDigest(
      scope.authorizedContextExposureDigest,
      "correlation context exposure digest",
    );
    return;
  }
  exactIdentity(scope.runId, "steering correlation run id");
  exactIdentity(scope.currentRefId, "steering correlation current ref id");
  if (
    !Number.isSafeInteger(scope.currentRefOrdinal) ||
    scope.currentRefOrdinal < 0 ||
    !Number.isSafeInteger(scope.currentSegmentOrdinal) ||
    scope.currentSegmentOrdinal < 0
  ) {
    throw new NativeCorrelationRejected(
      "steering correlation ref and segment ordinals must be nonnegative integers",
    );
  }
}

function validateStoredCorrelation(
  stored: StoredAcpSessionCorrelation,
  expectedPurpose: AcpCorrelationScope["purpose"],
): void {
  exactIdentity(stored.id, "stored correlation id");
  validateAcpCorrelationScope(stored.scope);
  if (
    stored.scope.purpose !== expectedPurpose ||
    stored.envelopeVersion !== ACP_SESSION_CORRELATION_ENVELOPE_VERSION ||
    stored.codecKind !== ACP_SESSION_CORRELATION_KIND ||
    (expectedPurpose === "carry"
      ? stored.state !== "eligible"
      : stored.state !== "current")
  ) {
    throw new NativeCorrelationRejected(
      "stored ACP correlation has the wrong purpose or state",
    );
  }
  exactIdentity(stored.ciphertext, "stored correlation ciphertext");
  exactDigest(stored.digest, "stored correlation digest");
}

export function createNativeCorrelationService(options: {
  readonly protector: AcpSessionCorrelationProtector;
}) {
  return {
    /**
     * Converts the exact eligible encrypted row into the only ACP start
     * branches. False-carry base prompts perform no lookup at all.
     */
    async resolveStart(input: {
      readonly promptKind: "base" | "steering";
      readonly carryContext: boolean;
      readonly stored: StoredAcpSessionCorrelation | null;
    }): Promise<ResolvedAcpSessionStart> {
      if (!input.carryContext && input.promptKind === "base") {
        if (input.stored !== null) {
          throw new NativeCorrelationRejected(
            "false-carry base prompt received a forbidden correlation lookup",
          );
        }
        return { kind: "new" };
      }

      if (!input.stored) return { kind: "target_not_found" };
      const expectedPurpose = input.promptKind === "steering"
        ? input.stored.scope.purpose
        : "carry";
      validateStoredCorrelation(input.stored, expectedPurpose);
      const raw = await options.protector.open(input.stored, input.stored.scope);
      let parsed: AcpSessionCorrelation;
      try {
        parsed = parseAcpSessionCorrelation(raw);
      } catch {
        throw new NativeCorrelationRejected(
          "stored ACP correlation envelope is malformed",
        );
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
      return options.protector.seal(
        createAcpSessionCorrelation(input.sessionId),
        input.scope,
      );
    },
  };
}

export type NativeCorrelationService = ReturnType<
  typeof createNativeCorrelationService
>;
