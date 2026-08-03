import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createAgentRegistry, type AcpAgentRegistry } from "acpx/runtime";

export const ACPX_REGISTRY_VERSION = "0.13.0" as const;
export const CODEX_ACP_FRONTEND_PACKAGE =
  "@agentclientprotocol/codex-acp" as const;
export const CODEX_ACP_FRONTEND_VERSION = "1.1.7" as const;
export const CODEX_ACP_FRONTEND_SHA256 =
  "0deb6b820dfed8804cd76b16a50210fe12202e5e339b5edaa23f6987f1742e0a" as const;

export interface ApprovedAcpLaunch {
  readonly registryName: string;
  readonly targetNativeCli: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly frontendPackage: string;
  readonly frontendVersion: string;
  readonly frontendDigest: string;
}

export interface ApprovedAcpFrontendArtifact {
  readonly bytes: Uint8Array;
  readonly targetFileName: string;
  readonly sha256: string;
}

export interface ApprovedAcpNativeAuthentication {
  /** Exact target-native argv appended to the resolved native executable. */
  readonly statusArgs: readonly string[];
  /** Non-secret operator action shown when native authentication is absent. */
  readonly loginGuidance: string;
}

const require = createRequire(import.meta.url);
const codexAcpEntrypoint = require.resolve(CODEX_ACP_FRONTEND_PACKAGE);
const codexLaunchArgv = Object.freeze([process.execPath, codexAcpEntrypoint]);

const APPROVED_ACP_LAUNCHES = Object.freeze({
  codex: Object.freeze({
    registryName: "codex",
    targetNativeCli: "codex",
    command: process.execPath,
    args: Object.freeze([codexAcpEntrypoint]),
    frontendPackage: CODEX_ACP_FRONTEND_PACKAGE,
    frontendVersion: CODEX_ACP_FRONTEND_VERSION,
    frontendDigest: CODEX_ACP_FRONTEND_SHA256,
  }),
} satisfies Readonly<Record<string, ApprovedAcpLaunch>>);

const APPROVED_ACP_NATIVE_AUTHENTICATION = Object.freeze({
  codex: Object.freeze({
    statusArgs: Object.freeze(["login", "status"]),
    loginGuidance: "codex login",
  }),
} satisfies Readonly<Record<string, ApprovedAcpNativeAuthentication>>);

const registry = createAgentRegistry({
  overrides: {
    codex: [...codexLaunchArgv],
  },
});

function exactStringArray(value: string | string[]): readonly string[] {
  const argv = typeof value === "string" ? [value] : value;
  if (
    argv.length === 0 ||
    argv.some(
      (entry) =>
        typeof entry !== "string" || entry.length === 0 || entry !== entry.trim(),
    )
  ) {
    throw new Error("ACPX registry returned an invalid launch argv");
  }
  return Object.freeze([...argv]);
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

/** Complete equality for the immutable ACP frontend and target-native CLI. */
export function sameApprovedAcpLaunch(
  left: ApprovedAcpLaunch,
  right: ApprovedAcpLaunch,
): boolean {
  return (
    left.registryName === right.registryName &&
    left.targetNativeCli === right.targetNativeCli &&
    left.command === right.command &&
    sameArgv(left.args, right.args) &&
    left.frontendPackage === right.frontendPackage &&
    left.frontendVersion === right.frontendVersion &&
    left.frontendDigest === right.frontendDigest
  );
}

function exactApprovedLaunch(launch: ApprovedAcpLaunch): ApprovedAcpLaunch {
  const approved = resolveApprovedAcpLaunch(launch.registryName);
  if (!sameApprovedAcpLaunch(launch, approved)) {
    throw new Error(
      `ACP launch does not match its approved artifact: ${launch.registryName}`,
    );
  }
  return approved;
}

/**
 * Resolves one exact, conformance-approved ACP frontend name.
 *
 * Membership in both ACPX's public registry and Paperclip's immutable catalog
 * is checked before `registry.resolve` so ACPX's raw-command fallback is never
 * reachable for an unknown or normalized spelling.
 */
export function resolveApprovedAcpLaunch(
  requestedName: string,
  candidateRegistry: AcpAgentRegistry = registry,
): ApprovedAcpLaunch {
  if (
    typeof requestedName !== "string" ||
    requestedName.length === 0 ||
    requestedName !== requestedName.trim()
  ) {
    throw new Error("ACP registry name must be exact and non-empty");
  }

  const listed = candidateRegistry.list();
  const approved = Object.prototype.hasOwnProperty.call(
    APPROVED_ACP_LAUNCHES,
    requestedName,
  )
    ? APPROVED_ACP_LAUNCHES[
        requestedName as keyof typeof APPROVED_ACP_LAUNCHES
      ]
    : undefined;

  if (!listed.includes(requestedName) || !approved) {
    throw new Error(`ACP registry name is not approved: ${requestedName}`);
  }

  const resolved = exactStringArray(candidateRegistry.resolve(requestedName));
  const expected = [approved.command, ...approved.args];
  if (!sameArgv(resolved, expected)) {
    throw new Error(`ACP registry launch drifted for ${requestedName}`);
  }

  return approved;
}

export function listApprovedAcpLaunchNames(): readonly string[] {
  return Object.freeze(Object.keys(APPROVED_ACP_LAUNCHES));
}

/**
 * Resolves catalog-owned native authentication only after the caller's full
 * launch identity is re-admitted. Adapter configuration and modules cannot
 * replace either the status argv or the operator guidance.
 */
export function resolveApprovedAcpNativeAuthentication(
  launch: ApprovedAcpLaunch,
): ApprovedAcpNativeAuthentication {
  const approved = exactApprovedLaunch(launch);
  const authentication = Object.prototype.hasOwnProperty.call(
    APPROVED_ACP_NATIVE_AUTHENTICATION,
    approved.registryName,
  )
    ? APPROVED_ACP_NATIVE_AUTHENTICATION[
        approved.registryName as keyof typeof APPROVED_ACP_NATIVE_AUTHENTICATION
      ]
    : undefined;
  if (!authentication || approved.targetNativeCli !== approved.registryName) {
    throw new Error(
      `ACP native authentication is not approved: ${approved.registryName}`,
    );
  }
  return authentication;
}

/**
 * Reads the worker-bundled frontend only after the complete immutable catalog
 * identity has been re-admitted, then verifies its bytes before they can be
 * materialized on an execution target.
 */
export async function readApprovedAcpFrontendArtifact(
  launch: ApprovedAcpLaunch,
): Promise<ApprovedAcpFrontendArtifact> {
  const approved = exactApprovedLaunch(launch);
  const entrypoint = approved.args[0];
  if (!entrypoint || approved.args.length !== 1) {
    throw new Error(
      `Approved ACP frontend entrypoint is not singular: ${approved.registryName}`,
    );
  }
  const bytes = await readFile(entrypoint);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== approved.frontendDigest) {
    throw new Error(
      `Approved ACP frontend artifact digest drifted: ${approved.registryName}`,
    );
  }
  return Object.freeze({
    bytes,
    targetFileName: `${approved.registryName}-acp-${approved.frontendVersion}.mjs`,
    sha256,
  });
}
