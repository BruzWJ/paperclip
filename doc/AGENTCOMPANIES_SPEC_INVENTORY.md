# Agent Companies Spec Inventory

This document indexes every part of the Paperclip codebase that touches the [Agent Companies Specification](../apps/docs/companies/companies-spec.md) (`agentcompanies/v1-draft`).

Use it when you need to:

1. **Update the spec** — know which implementation code must change in lockstep.
2. **Change code that involves the spec** — find all related files quickly.
3. **Keep things aligned** — audit whether implementation matches the spec.

---

## 1. Specification & Design Documents

| File                                               | Role                                                                                                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/docs/companies/companies-spec.md`            | **Normative spec** — defines the markdown-first package format (COMPANY.md, TEAM.md, AGENTS.md, PROJECT.md, TASK.md), reserved files, frontmatter schemas, and vendor extension conventions (`.paperclip.yaml`). |
| `doc/plans/2026-03-13-company-import-export-v2.md` | Implementation plan for the markdown-first package model cutover — phases, API changes, UI plan, and rollout strategy.                                                                                           |
| `doc/SPEC-implementation.md`                       | V1 implementation contract; references the portability system and `.paperclip.yaml` sidecar format.                                                                                                              |
| `doc/plans/2026-02-16-module-system.md`            | Module system plan; JSON-only company template sections superseded by the markdown-first model.                                                                                                                  |

## 2. Shared Types & Validators

These define the contract between server, CLI, and UI.

| File                                                    | What it defines                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/types/company-portability.ts`      | TypeScript interfaces: `CompanyPortabilityManifest`, `CompanyPortabilityFileEntry`, `CompanyPortabilityEnvInput`, export/import/preview request and result types, manifest entry types for agents, projects, tasks, recurring routines, and companies. |
| `packages/shared/src/validators/company-portability.ts` | Zod schemas for all portability request/response shapes — used by both server routes and CLI.                                                                                                                                                          |
| `packages/shared/src/types/index.ts`                    | Re-exports portability types.                                                                                                                                                                                                                          |
| `packages/shared/src/validators/index.ts`               | Re-exports portability validators.                                                                                                                                                                                                                     |

## 3. Server — Services

| File                                                | Responsibility                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/services/company-portability.ts`   | **Core portability service.** Export (manifest generation, markdown file emission, `.paperclip.yaml` sidecars), import (graph resolution, collision handling, entity creation), preview (planned-action summary). Handles recurring task <-> routine mapping, recurrence validation, and package README generation. References `agentcompanies/v1` version string. |
| `apps/server/src/services/routines.ts`              | Paperclip routine runtime service. Portability exports routines as recurring `TASK.md` entries and imports recurring tasks back through this service.                                                                                                                                                                                                              |
| `apps/server/src/services/company-export-readme.ts` | Generates `README.md` and Mermaid org-chart for exported company packages.                                                                                                                                                                                                                                                                                         |
| `apps/server/src/services/index.ts`                 | Re-exports `companyPortabilityService`.                                                                                                                                                                                                                                                                                                                            |

## 4. Server — Routes

| File                                  | Endpoints                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/server/src/routes/companies.ts` | `POST /api/companies/:companyId/exports/preview` — export preview<br>`POST /api/companies/:companyId/exports` — export package<br>`POST /api/companies/imports/preview` — new-company import preview<br>`POST /api/companies/imports` — perform new-company import |

Route registration lives in `apps/server/src/app.ts` via `companyRoutes(db, storage)`.

## 5. Server — Tests

| File                                                           | Coverage                                                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/__tests__/company-portability.test.ts`        | Unit tests for the portability service (export, import, preview, manifest shape, `agentcompanies/v1` version). |
| `apps/server/src/__tests__/company-portability-routes.test.ts` | Integration tests for the portability HTTP endpoints.                                                          |

## 6. CLI

| File                                          | Commands                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/commands/client/company.ts` | `company export` — exports a company package to disk (flags: `--out`, `--include`, `--projects`, `--tasks`, `--projectTasks`).<br>`company import <source>` — imports a company package from an exact local filesystem path or canonical GitHub HTTPS URL (flags: `--include`, `--target`, `--companyId`, `--newCompanyName`, `--agents`, `--collision`, `--dryRun`).<br>Reads/writes portable file entries and handles `.paperclip.yaml` filtering. |

## 7. UI — Pages

| File                                                                    | Role                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/ui/src/routes/_authenticated/$companyId/company/export/index.tsx` | Export UI: preview, manifest display, file tree visualization, ZIP archive creation and download. Filters `.paperclip.yaml` based on selection. Shows manifest and README in editor.                                             |
| `apps/ui/src/routes/_authenticated/$companyId/company/import/index.tsx` | Import UI: source input (upload/folder/GitHub URL/generic URL), ZIP reading, preview pane with dependency tree, entity selection checkboxes, trust/licensing warnings, secrets requirements, collision strategy, adapter config. |

## 8. UI — Components

| File                                  | Role                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/ui/src/components/patterns/FileTree.tsx` | Reusable file tree component for both import and export. Builds tree from `CompanyPortabilityFileEntry` items, parses frontmatter, shows action indicators (create/update/skip), and maps frontmatter field labels. |

## 9. UI — Libraries

| File                                | Role                                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/ui/src/lib/portable-files.ts` | Helpers for portable file entries: `getPortableFileText`, `getPortableFileDataUrl`, `getPortableFileContentType`, `isPortableImageFile`.                           |
| `apps/ui/src/lib/zip.ts`            | ZIP archive creation (`createZipArchive`) and reading (`readZipArchive`) — implements ZIP format from scratch for company packages. CRC32, DOS date/time encoding. |
| `apps/ui/src/lib/zip.test.ts`       | Tests for ZIP utilities; exercises round-trip with portability file entries and `.paperclip.yaml` content.                                                         |

## 10. UI — API Client

| File                           | Functions                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/ui/src/api/companies.ts` | `companiesApi.exportBundle`, `companiesApi.exportPreview`, `companiesApi.exportPackage`, `companiesApi.importPreview`, `companiesApi.importBundle` — typed fetch wrappers for the portability endpoints. |

## 11. Quick Cross-Reference by Spec Concept

| Spec concept                     | Primary implementation files                                                     |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `COMPANY.md` frontmatter & body  | `company-portability.ts` (export emitter + import parser)                        |
| `AGENTS.md` frontmatter & body   | `company-portability.ts`                                                         |
| `PROJECT.md` frontmatter & body  | `company-portability.ts`                                                         |
| `TASK.md` frontmatter & body     | `company-portability.ts`                                                         |
| `.paperclip.yaml` vendor sidecar | `company-portability.ts`, `routines.ts`, `CompanyExport.tsx`, `company.ts` (CLI) |
| `manifest.json`                  | `company-portability.ts` (generation), shared types (schema)                     |
| ZIP package format               | `zip.ts` (UI), `company.ts` (CLI file I/O)                                       |
| Collision resolution             | `company-portability.ts` (server), `CompanyImport.tsx` (UI)                      |
| Env/secrets declarations         | shared types (`CompanyPortabilityEnvInput`), `CompanyImport.tsx` (UI)            |
| README + org chart               | `company-export-readme.ts`                                                       |
