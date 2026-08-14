import path from "node:path";
import { type TaskStatus, TASK_STATUSES, ROUTINE_STATUSES, isCanonicalUuid } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { validateRegisteredAdapterRuntimeConfiguration } from "./agent-adapter-config-revisions.js";
import { resolvePortableRoutineDefinition } from "./company-portability-extension-parser.js";
import {
  DEFAULT_COLLISION_STRATEGY,
  resolveImportMode,
  collectAgentSafeImportPolicyErrors,
} from "./company-portability-manifest-types.js";
import {
  normalizeInclude,
  readPortableTextFile,
  ensureMarkdownPath,
} from "./company-portability-selection.js";
import { isPlainRecord } from "./company-portability-format-support.js";
import {
  applySelectedFilesToSource,
  parseFrontmatterMarkdown,
} from "./company-portability-format-support.js";
import type { CompanyPortabilityOperationScope } from "./company-portability.js";

export async function runBuildPreviewPhase1(
  scope: CompanyPortabilityOperationScope,
  state: Record<string, any>,
) {
  const { agents, projects, resolveSource, input, options } = scope;
  state.mode = resolveImportMode(options);

  state.requestedInclude = normalizeInclude(input.include);

  state.source = applySelectedFilesToSource(await resolveSource(input.source), input.selectedFiles);

  state.manifest = state.source.manifest;

  state.include = {
    company: state.requestedInclude.company && state.manifest.company !== null,
    agents: state.requestedInclude.agents && state.manifest.agents.length > 0,
    projects: state.requestedInclude.projects && state.manifest.projects.length > 0,
    tasks: state.requestedInclude.tasks && state.manifest.tasks.length > 0,
  };

  state.collisionStrategy = input.collisionStrategy ?? DEFAULT_COLLISION_STRATEGY;

  if (state.mode === "agent_safe" && state.collisionStrategy === "replace") {
    throw unprocessable("Safe import routes do not allow replace collision strategy.");
  }

  state.warnings = [...state.source.warnings];

  state.errors = [];

  if (state.include.company && !state.manifest.company) {
    state.errors.push("Manifest does not include company metadata.");
  }

  if (state.mode === "agent_safe") {
    state.errors.push(...collectAgentSafeImportPolicyErrors(state.manifest, state.include));
  }

  state.selectedSlugs = state.include.agents
    ? input.agents && input.agents !== "all"
      ? Array.from(new Set(input.agents))
      : state.manifest.agents.map((agent: any) => agent.slug)
    : [];

  state.selectedAgents = state.include.agents
    ? state.manifest.agents.filter((agent: any) => state.selectedSlugs.includes(agent.slug))
    : [];

  state.selectedMissing = state.selectedSlugs.filter(
    (slug: any) => !state.manifest.agents.some((agent: any) => agent.slug === slug),
  );

  for (const missing of state.selectedMissing) {
    state.errors.push(`Selected agent slug not found in manifest: ${missing}`);
  }

  state.adapterOverrides = input.adapterOverrides ?? {};

  for (const slug of Object.keys(state.adapterOverrides)) {
    if (!state.selectedAgents.some((agent: any) => agent.slug === slug)) {
      state.errors.push(`Adapter configuration targets an agent not selected for import: ${slug}.`);
    }
  }

  for (const selectedAgent of state.selectedAgents) {
    const slug = selectedAgent.slug;
    const sourceRevision = selectedAgent.adapterRevision;
    if (
      !isCanonicalUuid(sourceRevision.sourceRevisionId) ||
      !isPlainRecord(sourceRevision.acpConfiguration)
    ) {
      state.errors.push(`Selected imported agent ${slug} has an incomplete canonical adapter revision.`);
      continue;
    }
    const override = state.adapterOverrides[slug];
    if (!override) {
      state.errors.push(`Selected imported agent ${slug} requires an explicit target adapter override.`);
      continue;
    }
    const effectiveAdapterConfig = { ...override.adapterConfig };
    try {
      await validateRegisteredAdapterRuntimeConfiguration({
        adapterType: override.adapterType,
        adapterConfig: effectiveAdapterConfig,
      });
    } catch (error) {
      state.errors.push(
        `Invalid adapter configuration for imported agent ${slug}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (state.include.agents && state.selectedAgents.length === 0) {
    state.warnings.push("No agents selected for import.");
  }

  for (const agent of state.selectedAgents) {
    const filePath = ensureMarkdownPath(agent.path);
    const markdown = readPortableTextFile(state.source.files, filePath);
    if (typeof markdown !== "string") {
      state.errors.push(`Missing markdown file for agent ${agent.slug}: ${filePath}`);
      continue;
    }
    const parsed = parseFrontmatterMarkdown(markdown);
    if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "agent") {
      state.warnings.push(`Agent markdown ${filePath} does not declare kind: agent in frontmatter.`);
    }
  }

  if (state.include.projects) {
    for (const project of state.manifest.projects) {
      const markdown = readPortableTextFile(state.source.files, ensureMarkdownPath(project.path));
      if (typeof markdown !== "string") {
        state.errors.push(`Missing markdown file for project ${project.slug}: ${project.path}`);
        continue;
      }
      const parsed = parseFrontmatterMarkdown(markdown);
      if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "project") {
        state.warnings.push(
          `Project markdown ${project.path} does not declare kind: project in frontmatter.`,
        );
      }
    }
  }

  if (state.include.tasks) {
    for (const task of state.manifest.tasks) {
      const markdown = readPortableTextFile(state.source.files, ensureMarkdownPath(task.path));
      if (typeof markdown !== "string") {
        state.errors.push(`Missing markdown file for task ${task.slug}: ${task.path}`);
        continue;
      }
      const parsed = parseFrontmatterMarkdown(markdown);
      if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "task") {
        state.warnings.push(`Task markdown ${task.path} does not declare kind: task in frontmatter.`);
      }
      if (task.recurring) {
        if (!task.projectSlug) {
          state.errors.push(`Recurring task ${task.slug} must declare a project to import as a routine.`);
        }
        if (!task.ownerAgentSlug) {
          state.errors.push(`Recurring task ${task.slug} must declare an owner to import as a routine.`);
        }
        const resolvedRoutine = resolvePortableRoutineDefinition(task);
        state.warnings.push(...resolvedRoutine.warnings);
        state.errors.push(...resolvedRoutine.errors);
        if (
          task.lifecycleStatus !== "open" ||
          !ROUTINE_STATUSES.includes(task.boardPresentationStatus as (typeof ROUTINE_STATUSES)[number])
        ) {
          state.errors.push(
            `Recurring task ${task.slug} requires lifecycleStatus=open and a canonical routine boardPresentationStatus.`,
          );
        }
      } else if (!TASK_STATUSES.includes(task.boardPresentationStatus as TaskStatus)) {
        state.errors.push(`Task ${task.slug} requires a canonical task boardPresentationStatus.`);
      }
    }
  }

  for (const envInput of state.manifest.envInputs) {
    if (envInput.portability === "system_dependent") {
      const scope = envInput.projectSlug ? ` for project ${envInput.projectSlug}` : "";
      state.warnings.push(
        `Environment input ${envInput.key}${scope} is system-dependent and may need manual adjustment after import.`,
      );
    }
  }
}
