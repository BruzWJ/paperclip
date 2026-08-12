import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalizeMoneyAmount, type Company } from "@paperclipai/shared";
import {
  assertDeleteConfirmation,
  registerCompanyCommands,
} from "../commands/client/company.js";

function makeCompany(overrides: Partial<Company>): Company {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Alpha",
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    taskPrefix: "ALP",
    taskCounter: 1,
    budgetCurrency: "USD",
    budgetMonthlyAmount: canonicalizeMoneyAmount("0"),
    knownSpendAmount: canonicalizeMoneyAmount("0"),
    attachmentMaxBytes: 10 * 1024 * 1024,
    requireBoardApprovalForNewAgents: false,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    defaultResponsibleUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("assertDeleteConfirmation", () => {
  const companyId = "abcdef12-3456-4789-8abc-def012345678";

  it("requires --yes", () => {
    expect(() => assertDeleteConfirmation(companyId, { confirm: companyId })).toThrow(/requires --yes/);
  });

  it("accepts the exact matching UUID confirmation", () => {
    expect(() => assertDeleteConfirmation(companyId, { yes: true, confirm: companyId })).not.toThrow();
  });

  it("rejects UUID case and whitespace variants", () => {
    expect(() => assertDeleteConfirmation(companyId, { yes: true, confirm: companyId.toUpperCase() }))
      .toThrow(/does not match exact/);
    expect(() => assertDeleteConfirmation(companyId, { yes: true, confirm: `${companyId} ` }))
      .toThrow(/does not match exact/);
  });

  it("rejects mismatched confirmation", () => {
    expect(() => assertDeleteConfirmation(companyId, { yes: true, confirm: "nope" }))
      .toThrow(/does not match exact/);
  });

  it("rejects a non-canonical company selector", () => {
    expect(() => assertDeleteConfirmation("PAP", { yes: true, confirm: "PAP" }))
      .toThrow(/canonical company UUID/);
  });
});

describe("company delete help", () => {
  it("exposes only the exact canonical UUID selector", () => {
    const program = new Command();
    registerCompanyCommands(program);
    const companyCommand = program.commands.find((command) => command.name() === "company");
    const deleteCommand = companyCommand?.commands.find((command) => command.name() === "delete");
    const help = deleteCommand?.helpInformation() ?? "";

    expect(help).toContain("<company-id>");
    expect(help).toContain("canonical UUID");
    expect(help).not.toContain("--by");
    expect(help).not.toContain("task prefix");
    expect(help).not.toContain("shortname");
  });

  it("fetches and deletes only by the exact canonical UUID", async () => {
    const target = makeCompany({
      id: "abcdef12-3456-4789-8abc-def012345678",
      taskPrefix: "PAP",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const program = new Command();
    program.exitOverride();
    registerCompanyCommands(program);
    await program.parseAsync([
      "company",
      "delete",
      target.id,
      "--yes",
      "--confirm",
      target.id,
      "--api-base",
      "http://paperclip.test",
      "--api-key",
      "board-token",
      "--json",
    ], { from: "user" });

    expect(fetchMock.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"]))
      .toEqual([
        [`http://paperclip.test/api/companies/${target.id}`, "GET"],
        [`http://paperclip.test/api/companies/${target.id}`, "DELETE"],
      ]);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
