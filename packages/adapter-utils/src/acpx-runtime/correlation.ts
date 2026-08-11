export const ACP_SESSION_CORRELATION_ENVELOPE_VERSION =
  "issue-execution-native/v1" as const;
export const ACP_SESSION_CORRELATION_KIND = "acp-session/v1" as const;

interface AcpSessionCorrelationPayload {
  readonly sessionId: string;
}

/**
 * The one opaque worker correlation accepted by the canonical ACP runtime.
 *
 * This control envelope is never an adapter extension point: every admitted
 * backend speaks ACP and therefore has the same fixed correlation shape.
 */
export interface AcpSessionCorrelation {
  readonly version: typeof ACP_SESSION_CORRELATION_ENVELOPE_VERSION;
  readonly kind: typeof ACP_SESSION_CORRELATION_KIND;
  readonly payload: AcpSessionCorrelationPayload;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function exactOpaqueSessionId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("ACP session id must be non-empty");
  }
  return value;
}

export function createAcpSessionCorrelation(
  sessionId: string,
): AcpSessionCorrelation {
  return Object.freeze({
    version: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
    kind: ACP_SESSION_CORRELATION_KIND,
    payload: Object.freeze({
      sessionId: exactOpaqueSessionId(sessionId),
    }),
  });
}

export function parseAcpSessionCorrelation(
  value: unknown,
): AcpSessionCorrelation {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["version", "kind", "payload"]) ||
    value.version !== ACP_SESSION_CORRELATION_ENVELOPE_VERSION ||
    value.kind !== ACP_SESSION_CORRELATION_KIND ||
    !isPlainRecord(value.payload) ||
    !hasExactKeys(value.payload, ["sessionId"])
  ) {
    throw new Error("ACP session correlation envelope is invalid");
  }
  return createAcpSessionCorrelation(
    exactOpaqueSessionId(value.payload.sessionId),
  );
}
