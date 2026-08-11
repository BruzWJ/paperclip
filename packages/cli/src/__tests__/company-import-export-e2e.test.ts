import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeMoneyAmount,
  type CompanyPortabilityExportResult,
  type CompanyPortabilityImportResult,
  type CompanyPortabilityManifest,
  type CompanyPortabilityPreviewResult,
} from "@paperclipai/shared";
import { registerCompanyCommands } from "../commands/client/company.js";
import { createStoredZipArchive } from "./helpers/zip.js";

const ORIGINAL_ENV = { ...process.env };
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const IMPORTED_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const API_BASE = "http://paperclip.test";

const INCLUDE_ALL = {
  company: true,
  agents: true,
  projects: true,
  issues: true,
  skills: false,
} as const;

function portabilityManifest(): CompanyPortabilityManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-02T00:00:00.000Z",
    source: {
      companyId: COMPANY_ID,
      companyName: "Portable Paperclip",
    },
    includes: INCLUDE_ALL,
    company: {
      path: "COMPANY.md",
      name: "Portable Paperclip",
      description: "Deterministic CLI portability fixture",
      budgetCurrency: "USD",
      budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
      attachmentMaxBytes: null,
      brandColor: null,
      logoPath: null,
      requireBoardApprovalForNewAgents: false,
    },
    sidebar: null,
    agents: [],
    skills: [],
    projects: [],
    issues: [],
    envInputs: [],
  };
}

function portabilityExport(): CompanyPortabilityExportResult {
  return {
    rootPath: "portable-paperclip",
    manifest: portabilityManifest(),
    files: {
      "COMPANY.md": "# Portable Paperclip\n",
      ".paperclip.yaml": 'schema: "paperclip/v1"\n',
    },
    warnings: [],
    paperclipExtensionPath: ".paperclip.yaml",
  };
}

function requireTextPortableFiles(
  files: CompanyPortabilityExportResult["files"],
): Record<string, string> {
  const textFiles: Record<string, string> = {};
  for (const [relativePath, entry] of Object.entries(files)) {
    if (typeof entry !== "string") {
      throw new Error(
        `Stored ZIP test fixture requires text content, but ${relativePath} is base64-encoded.`,
      );
    }
    textFiles[relativePath] = entry;
  }
  return textFiles;
}

function portabilityPreview(input: {
  targetCompanyId: string | null;
  targetCompanyName: string;
  companyAction: "none" | "create" | "update";
}): CompanyPortabilityPreviewResult {
  const exported = portabilityExport();
  return {
    include: INCLUDE_ALL,
    targetCompanyId: input.targetCompanyId,
    targetCompanyName: input.targetCompanyName,
    collisionStrategy: "rename",
    selectedAgentSlugs: [],
    plan: {
      companyAction: input.companyAction,
      agentPlans: [],
      projectPlans: [],
      issuePlans: [],
    },
    manifest: exported.manifest,
    files: exported.files,
    envInputs: [],
    warnings: [],
    errors: [],
  };
}

function portabilityImport(): CompanyPortabilityImportResult {
  return {
    company: {
      id: IMPORTED_COMPANY_ID,
      name: "Imported Portable Paperclip",
      action: "created",
    },
    agents: [],
    projects: [],
    envInputs: [],
    warnings: [],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  registerCompanyCommands(program);
  return program;
}

async function runCommand(args: string[]): Promise<void> {
  await makeProgram().parseAsync(args, { from: "user" });
}

function parseRequestBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("paperclipai company import/export HTTP boundary", () => {
  let tempRoot = "";
  let fetchMock: ReturnType<typeof vi.fn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalStdinIsTTY: boolean | undefined;
  let originalStdoutIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.DATABASE_URL;
    delete process.env.PAPERCLIP_BOARD_API_URL;
    delete process.env.PAPERCLIP_BOARD_API_KEY;
    delete process.env.PAPERCLIP_BOARD_COMPANY_ID;
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "paperclip-company-cli-boundary-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    originalStdinIsTTY = process.stdin.isTTY;
    originalStdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalStdoutIsTTY,
      configurable: true,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("writes an exported package and posts the same local files to a new-company import", async () => {
    const exportDir = path.join(tempRoot, "exported-company");
    const exported = portabilityExport();
    fetchMock.mockResolvedValueOnce(jsonResponse(exported));

    await runCommand([
      "company",
      "export",
      COMPANY_ID,
      "--out",
      exportDir,
      "--include",
      "company,agents,projects,issues",
      "--api-base",
      API_BASE,
      "--api-key",
      "board-token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${API_BASE}/api/companies/${COMPANY_ID}/exports`,
    );
    expect(parseRequestBody(fetchMock.mock.calls[0]!)).toEqual({
      include: INCLUDE_ALL,
      skills: [],
      projects: [],
      issues: [],
      projectIssues: [],
      expandReferencedSkills: false,
    });
    expect(readFileSync(path.join(exportDir, "COMPANY.md"), "utf8")).toBe(
      exported.files["COMPANY.md"],
    );
    expect(readFileSync(path.join(exportDir, ".paperclip.yaml"), "utf8")).toBe(
      exported.files[".paperclip.yaml"],
    );

    fetchMock.mockClear();
    logSpy.mockClear();
    const preview = portabilityPreview({
      targetCompanyId: null,
      targetCompanyName: "Imported Portable Paperclip",
      companyAction: "create",
    });
    const imported = portabilityImport();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(preview))
      .mockResolvedValueOnce(jsonResponse(imported, 201));

    await runCommand([
      "company",
      "import",
      exportDir,
      "--target",
      "new",
      "--new-company-name",
      "Imported Portable Paperclip",
      "--include",
      "company,agents,projects,issues",
      "--yes",
      "--api-base",
      API_BASE,
      "--api-key",
      "board-token",
      "--json",
    ]);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${API_BASE}/api/companies/imports/preview`,
      `${API_BASE}/api/companies/imports`,
    ]);
    const previewPayload = parseRequestBody(fetchMock.mock.calls[0]!);
    const applyPayload = parseRequestBody(fetchMock.mock.calls[1]!);
    expect(previewPayload).toMatchObject({
      source: {
        type: "inline",
        rootPath: "exported-company",
        files: exported.files,
      },
      include: INCLUDE_ALL,
      target: {
        mode: "new_company",
        newCompanyName: "Imported Portable Paperclip",
      },
      agents: "all",
      collisionStrategy: "rename",
    });
    expect(applyPayload).toEqual(previewPayload);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual(imported);
  });

  it("reads a stored zip and previews an existing-company import without a server or database", async () => {
    const exported = portabilityExport();
    const zipPath = path.join(tempRoot, "portable-company.zip");
    writeFileSync(
      zipPath,
      createStoredZipArchive(requireTextPortableFiles(exported.files), "portable-paperclip"),
    );
    const preview = portabilityPreview({
      targetCompanyId: COMPANY_ID,
      targetCompanyName: "Portable Paperclip",
      companyAction: "none",
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(preview));

    await runCommand([
      "company",
      "import",
      zipPath,
      "--target",
      "existing",
      "--company-id",
      COMPANY_ID,
      "--include",
      "company,agents,projects,issues",
      "--dry-run",
      "--api-base",
      API_BASE,
      "--api-key",
      "board-token",
      "--json",
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${API_BASE}/api/companies/${COMPANY_ID}/imports/preview`,
    );
    expect(parseRequestBody(fetchMock.mock.calls[0]!)).toMatchObject({
      source: {
        type: "inline",
        rootPath: "portable-paperclip",
        files: exported.files,
      },
      target: {
        mode: "existing_company",
        companyId: COMPANY_ID,
      },
    });
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual(preview);
  });
});
