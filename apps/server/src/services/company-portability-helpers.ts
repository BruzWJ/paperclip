import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  CompanyPortabilityEnvInput,
  CompanyPortabilityFileEntry,
  CompanyPortabilityManifest,
  CompanyPortabilityPreview,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { gitHubApiBase, resolveRawGitHubUrl } from "./github-fetch.js";
import { requireSecretMutationActor, type SecretMutationActor } from "./secrets.js";
import { validateRegisteredAdapterRuntimeConfiguration } from "./agent-adapter-config-revisions.js";
import { joinPortablePaths, requirePortablePath } from "./portable-path.js";
import type { CompanyPortabilityContext } from "./company-portability.js";
import type { PortableAgentPermissionGrant } from "./company-portability-extension-parser.js";
import type { ResolvedSource } from "./company-portability-manifest-types.js";
import {
  buildManifestFromPackageFiles,
  parseCompanyImportGithubSource,
} from "./company-portability-manifest-parser.js";
import {
  bufferToPortableBinaryFile,
  inferContentTypeFromPath,
  validateFileMap,
} from "./company-portability-selection.js";
import * as portabilitySources from "./company-portability-format-support.js";
import { parseFrontmatterMarkdown } from "./company-portability-format-support.js";

export function buildCompanyPortabilityHelpers(context: CompanyPortabilityContext) {
  const { access, secrets, defaultSecretProvider } = context;
  async function applyImportedAgentPermissionGrants(
    companyId: string,
    agentId: string,
    permissionGrants: PortableAgentPermissionGrant[],
    grantedByUserId: string | null,
  ) {
    if (permissionGrants.length === 0) return;
    await access.ensureMembership(companyId, "agent", agentId, "member", "active");
    for (const grant of permissionGrants) {
      await access.setPrincipalPermission(
        companyId,
        "agent",
        agentId,
        grant.permissionKey,
        true,
        grantedByUserId,
        grant.scope ?? null,
      );
    }
  }

  function assertKnownImportAdapterType(type: string | null | undefined): string {
    if (typeof type !== "string" || type.length === 0 || type !== type.trim()) {
      throw unprocessable("Adapter type must be an exact non-blank string");
    }
    return type;
  }

  async function prepareImportedAgentAdapter(
    adapterType: string | null | undefined,
    adapterConfig: Record<string, unknown>,
  ) {
    const effectiveAdapterType = assertKnownImportAdapterType(adapterType);
    const explicitAdapterConfig = { ...adapterConfig };
    await validateRegisteredAdapterRuntimeConfiguration({
      adapterType: effectiveAdapterType,
      adapterConfig: explicitAdapterConfig,
    });
    return {
      adapterType: effectiveAdapterType,
      adapterConfig: explicitAdapterConfig,
    };
  }

  async function materializeImportEnvInputValues(
    companyId: string,
    manifest: CompanyPortabilityManifest,
    envInputs: CompanyPortabilityEnvInput[],
    secretValues: Record<string, string> | null | undefined,
    actor: SecretMutationActor,
    createdSecretIds: string[] = [],
  ) {
    requireSecretMutationActor(actor);
    if (envInputs.length === 0) return;
    const missingRequired = envInputs.filter((input) => {
      if (input.requirement !== "required") return false;
      const value = portabilitySources.envInputValue(input, secretValues);
      return value === null || value.trim().length === 0;
    });
    if (missingRequired.length > 0) {
      throw unprocessable(
        `Required environment values are missing: ${missingRequired.map(portabilitySources.envInputScopedKey).join(", ")}`,
      );
    }

    for (const input of envInputs) {
      const value = portabilitySources.envInputValue(input, secretValues);
      if (value === null || value.trim().length === 0) continue;

      if (input.kind === "plain") {
        portabilitySources.writeManifestEnvBinding(manifest, input, {
          type: "plain",
          value,
        });
        continue;
      }

      const suffix = randomUUID().slice(0, 8);
      const label = portabilitySources.importSecretLabel(input);
      const secret = await secrets.create(
        companyId,
        {
          name: `Imported ${label} ${suffix}`,
          key: portabilitySources.importSecretKey(input, suffix),
          provider: defaultSecretProvider,
          value,
          description: input.description ?? `Imported ${input.key} for ${label}.`,
        },
        actor,
      );
      createdSecretIds.push(secret.id);
      portabilitySources.writeManifestEnvBinding(manifest, input, {
        type: "secret_ref",
        secretId: secret.id,
        version: "latest",
      });
    }
  }

  function resolveImportedOwnerAgentId(
    ownerSlug: string | null | undefined,
    importedSlugToAgentId: Map<string, string>,
    existingSlugToAgentId: Map<string, string>,
    agentStatusById: Map<string, string | null | undefined>,
    warnings: string[],
    subjectLabel: string,
  ) {
    if (!ownerSlug) return null;
    const ownerAgentId = importedSlugToAgentId.get(ownerSlug) ?? existingSlugToAgentId.get(ownerSlug) ?? null;
    if (!ownerAgentId) return null;
    const ownerStatus = agentStatusById.get(ownerAgentId) ?? null;
    if (ownerStatus === "pending_approval" || ownerStatus === "terminated") {
      warnings.push(
        `${subjectLabel} owner ${ownerSlug} is ${ownerStatus}; imported work was left without an owner.`,
      );
      return null;
    }
    return ownerAgentId;
  }

  async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      return buildManifestFromPackageFiles(validateFileMap(source.files, source.rootPath));
    }

    const parsed = parseCompanyImportGithubSource(source.url);
    if (parsed.basePath) {
      requirePortablePath(parsed.basePath, "GitHub package path");
    }
    requirePortablePath(parsed.companyPath, "GitHub company path");
    const ref = parsed.ref;
    const warnings: string[] = [];
    const companyMarkdown = await portabilitySources.fetchOptionalText(
      resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, parsed.companyPath),
    );
    if (!companyMarkdown) {
      throw unprocessable("GitHub company package is missing COMPANY.md");
    }

    const files: Record<string, CompanyPortabilityFileEntry> = {
      "COMPANY.md": companyMarkdown,
    };
    const apiBase = gitHubApiBase(parsed.hostname);
    const tree = await portabilitySources.fetchJson<{
      tree?: Array<{ path: string; type: string }>;
    }>(`${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`);
    const basePrefix = parsed.basePath ? `${parsed.basePath}/` : "";
    const candidatePaths: Array<{ repoPath: string; relativePath: string }> = [];
    for (const entry of tree.tree ?? []) {
      if (entry.type !== "blob" || typeof entry.path !== "string") continue;
      if (basePrefix && !entry.path.startsWith(basePrefix)) continue;
      const relativePath = basePrefix ? entry.path.slice(basePrefix.length) : entry.path;
      if (
        !relativePath.endsWith(".md") &&
        relativePath !== ".paperclip.yaml" &&
        relativePath !== ".paperclip.yml"
      ) {
        continue;
      }
      candidatePaths.push({
        repoPath: requirePortablePath(entry.path, "GitHub tree path"),
        relativePath: requirePortablePath(relativePath, "GitHub package file path"),
      });
    }
    for (const { repoPath, relativePath } of candidatePaths) {
      if (files[relativePath] !== undefined) continue;
      files[relativePath] = await portabilitySources.fetchText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
      );
    }
    const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
    const includeEntries = portabilitySources.readIncludeEntries(companyDoc.frontmatter);
    for (const includeEntry of includeEntries) {
      const repoPath = parsed.basePath
        ? joinPortablePaths(parsed.basePath, includeEntry.path)
        : includeEntry.path;
      const relativePath = includeEntry.path;
      if (files[relativePath] !== undefined) continue;
      if (!(repoPath.endsWith(".md") || repoPath.endsWith(".yaml") || repoPath.endsWith(".yml"))) continue;
      files[relativePath] = await portabilitySources.fetchText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
      );
    }

    const resolved = buildManifestFromPackageFiles(files);
    const companyLogoPath = resolved.manifest.company?.logoPath;
    if (companyLogoPath && !resolved.files[companyLogoPath]) {
      const repoPath = parsed.basePath
        ? joinPortablePaths(parsed.basePath, companyLogoPath)
        : companyLogoPath;
      try {
        const binary = await portabilitySources.fetchBinary(
          resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
        );
        resolved.files[companyLogoPath] = bufferToPortableBinaryFile(
          binary,
          inferContentTypeFromPath(companyLogoPath),
        );
      } catch (err) {
        warnings.push(
          `Failed to fetch company logo ${companyLogoPath} from GitHub: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    resolved.warnings.unshift(...warnings);
    return resolved;
  }
  return {
    applyImportedAgentPermissionGrants,
    assertKnownImportAdapterType,
    prepareImportedAgentAdapter,
    materializeImportEnvInputValues,
    resolveImportedOwnerAgentId,
    resolveSource,
  };
}
export type CompanyPortabilityHelpers = ReturnType<typeof buildCompanyPortabilityHelpers>;
