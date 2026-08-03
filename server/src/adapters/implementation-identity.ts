import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ACP_ADAPTER_DEFINITION_VERSION,
  ACP_PROTOCOL_VERSION,
  adapterImplementationIdentityKey,
  freezeAdapterImplementationIdentity,
  isAdapterImplementationIdentity,
  type AdapterImplementationIdentity,
  type AdapterImplementationOrigin,
} from "@paperclipai/shared";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";

const attachedIdentities = new WeakMap<
  ServerAdapterModule,
  Readonly<AdapterImplementationIdentity>
>();

function hashField(hash: ReturnType<typeof createHash>, value: string): void {
  hash.update(String(Buffer.byteLength(value, "utf8")));
  hash.update(":");
  hash.update(value);
  hash.update("\0");
}

function artifactEntries(
  root: string,
  relative = "",
): Array<{ relative: string; absolute: string; stat: fs.Stats }> {
  const absolute = relative ? path.join(root, relative) : root;
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory()) return [{ relative, absolute, stat }];

  const entries: Array<{ relative: string; absolute: string; stat: fs.Stats }> =
    [];
  for (const name of fs.readdirSync(absolute).sort()) {
    if (name === ".git" || name === "node_modules") continue;
    const childRelative = relative ? path.join(relative, name) : name;
    entries.push(...artifactEntries(root, childRelative));
  }
  return entries;
}

/**
 * Hashes package/build content and rejects internal symlinks so unchanged
 * link text cannot redirect a pinned implementation to changed content.
 * Dependency directories are deliberately outside the adapter artifact
 * identity: the installed adapter package is the executable unit, while an
 * unavailable dependency makes the retained implementation fail closed.
 */
export function digestAdapterArtifact(root: string): string {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const rootStat = fs.lstatSync(resolvedRoot);
  const hash = createHash("sha256");
  hashField(hash, "paperclip.adapter-artifact/v1");
  if (!rootStat.isDirectory()) {
    hashField(hash, path.basename(resolvedRoot));
  }
  for (const entry of artifactEntries(resolvedRoot)) {
    if (entry.stat.isSymbolicLink()) {
      throw new Error(
        `Adapter artifact contains an unsupported symbolic link: ${entry.relative}`,
      );
    }
    const normalizedPath =
      entry.relative.split(path.sep).join("/") || path.basename(resolvedRoot);
    hashField(hash, normalizedPath);
    hashField(
      hash,
      entry.stat.isFile()
        ? "file"
        : "other",
    );
    hashField(hash, String(entry.stat.mode & 0o777));
    if (entry.stat.isFile()) {
      const bytes = fs.readFileSync(entry.absolute);
      hashField(hash, String(bytes.byteLength));
      hash.update(bytes);
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function canonicalModuleValue(
  value: unknown,
  seen: WeakSet<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "function") {
    return {
      functionSource: Function.prototype.toString.call(value),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalModuleValue(entry, seen));
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return { circularReference: true };
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    result[key] = canonicalModuleValue(
      (value as Record<string, unknown>)[key],
      seen,
    );
  }
  return result;
}

/** Host-computed fallback for runtime/test registrations without a package. */
export function digestServerAdapterModule(adapter: ServerAdapterModule): string {
  return createHash("sha256")
    .update("paperclip.adapter-module/v1\0")
    .update(
      JSON.stringify(canonicalModuleValue(adapter, new WeakSet<object>())),
      "utf8",
    )
    .digest("hex");
}

export function createAdapterImplementationIdentity(input: {
  adapterType: string;
  origin: AdapterImplementationOrigin;
  packageName: string;
  packageVersion: string;
  buildIdentity: string;
  artifactDigest: string;
}): Readonly<AdapterImplementationIdentity> {
  return freezeAdapterImplementationIdentity({
    adapterType: input.adapterType,
    definitionVersion: ACP_ADAPTER_DEFINITION_VERSION,
    protocolVersion: ACP_PROTOCOL_VERSION,
    origin: input.origin,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    buildIdentity: input.buildIdentity,
    artifactDigest: input.artifactDigest,
  });
}

export function attachAdapterImplementationIdentity(
  adapter: ServerAdapterModule,
  identity: AdapterImplementationIdentity,
): void {
  if (
    !isAdapterImplementationIdentity(identity) ||
    identity.adapterType !== adapter.type
  ) {
    throw new Error(
      "Adapter implementation identity does not match its executable module",
    );
  }
  const frozen = freezeAdapterImplementationIdentity(identity);
  const existing = attachedIdentities.get(adapter);
  if (
    existing &&
    adapterImplementationIdentityKey(existing) !==
      adapterImplementationIdentityKey(frozen)
  ) {
    throw new Error(
      "Adapter executable module already has a different implementation identity",
    );
  }
  attachedIdentities.set(adapter, frozen);
}

export function attachedAdapterImplementationIdentity(
  adapter: ServerAdapterModule,
): Readonly<AdapterImplementationIdentity> | null {
  return attachedIdentities.get(adapter) ?? null;
}
