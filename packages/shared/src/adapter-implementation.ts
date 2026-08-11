/** The version of Paperclip's immutable ACPX runtime adapter definition. */
export const ACPX_RUNTIME_DEFINITION_VERSION = "acpx-runtime/v1" as const;
export const ACP_PROTOCOL_VERSION = 1 as const;

/**
 * Immutable ACPX discovery provenance pinned by every adapter configuration
 * revision. A package version is descriptive; artifactDigest is the
 * host-computed content identity included in the canonical configuration
 * digest. Executable and local-runtime readiness are enforced at launch.
 */
export interface AdapterImplementationIdentity {
  adapterType: string;
  definitionVersion: typeof ACPX_RUNTIME_DEFINITION_VERSION;
  protocolVersion: typeof ACP_PROTOCOL_VERSION;
  packageName: string;
  packageVersion: string;
  buildIdentity: string;
  artifactDigest: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function exactNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim()
  );
}

export function isAdapterImplementationIdentity(
  value: unknown,
): value is AdapterImplementationIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 7 &&
    exactNonEmptyString(candidate.adapterType) &&
    candidate.definitionVersion === ACPX_RUNTIME_DEFINITION_VERSION &&
    candidate.protocolVersion === ACP_PROTOCOL_VERSION &&
    exactNonEmptyString(candidate.packageName) &&
    exactNonEmptyString(candidate.packageVersion) &&
    exactNonEmptyString(candidate.buildIdentity) &&
    typeof candidate.artifactDigest === "string" &&
    SHA256_HEX.test(candidate.artifactDigest)
  );
}

export function adapterImplementationIdentityKey(
  identity: AdapterImplementationIdentity,
): string {
  if (!isAdapterImplementationIdentity(identity)) {
    throw new Error("Invalid adapter implementation identity");
  }
  return JSON.stringify([
    identity.adapterType,
    identity.definitionVersion,
    identity.protocolVersion,
    identity.packageName,
    identity.packageVersion,
    identity.buildIdentity,
    identity.artifactDigest,
  ]);
}

export function sameAdapterImplementationIdentity(
  left: AdapterImplementationIdentity,
  right: AdapterImplementationIdentity,
): boolean {
  return (
    isAdapterImplementationIdentity(left) &&
    isAdapterImplementationIdentity(right) &&
    adapterImplementationIdentityKey(left) ===
      adapterImplementationIdentityKey(right)
  );
}

export function freezeAdapterImplementationIdentity(
  identity: AdapterImplementationIdentity,
): Readonly<AdapterImplementationIdentity> {
  if (!isAdapterImplementationIdentity(identity)) {
    throw new Error("Invalid adapter implementation identity");
  }
  return Object.freeze({ ...identity });
}
