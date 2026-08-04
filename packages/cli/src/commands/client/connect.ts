import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Company } from "@paperclipai/shared";
import { createBoardApiKeySchema } from "@paperclipai/shared";
import { loginBoardCli } from "../../client/board-auth.js";
import { PaperclipApiClient } from "../../client/http.js";
import { resolveProfile, readContext, setCurrentProfile, upsertProfile } from "../../client/context.js";
import {
  addCommonClientOptions,
  handleCommandError,
  normalizeApiBase,
  printOutput,
  resolveApiBase,
  type BaseClientOptions,
} from "./common.js";

interface ConnectOptions extends BaseClientOptions {
  profile?: string;
  apiKeyEnvVarName?: string;
  tokenName?: string;
}

interface CreatedBoardKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
  expiresAt: string | null;
}

export function registerConnectCommand(program: Command): void {
  addCommonClientOptions(
    program
      .command("connect")
      .description("Interactively connect the CLI as a board operator")
      .option("--api-key-env-var-name <name>", "Env var name to store in the profile", "PAPERCLIP_BOARD_API_KEY")
      .option("--token-name <name>", "Token label to create")
      .action(async (opts: ConnectOptions) => {
        try {
          const result = await connectWizard(opts);
          printOutput(result, { json: opts.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

async function connectWizard(opts: ConnectOptions) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("`paperclipai connect` is interactive. For scripts, pass --api-base/--api-key or use context set/token commands.");
  }

  p.intro(pc.bgCyan(pc.black(" paperclipai connect ")));

  const context = readContext(opts.context);
  const resolvedProfile = resolveProfile(context, opts.profile);
  const initialApiBase = resolveApiBase(opts, resolvedProfile.profile);
  const apiBaseInput = await p.text({
    message: "Paperclip API base",
    initialValue: initialApiBase,
    placeholder: "http://localhost:3100",
  });
  assertNotCancelled(apiBaseInput);
  const apiBase = normalizeApiBase(String(apiBaseInput || initialApiBase));
  console.log(pc.dim(`Checking ${apiBase}/api/health ...`));
  await verifyHealth(apiBase);

  const boardLogin = await loginBoardCli({
    apiBase,
    requestedAccess: "board",
    requestedCompanyId: opts.companyId ?? resolvedProfile.profile.companyId ?? null,
    command: "paperclipai connect",
  });
  const boardApi = new PaperclipApiClient({ apiBase, apiKey: boardLogin.token });
  const companies = (await boardApi.get<Company[]>("/api/companies")) ?? [];

  const profileName = opts.profile?.trim() || await askProfileName(resolvedProfile.name);
  const apiKeyEnvVarName = opts.apiKeyEnvVarName?.trim() || "PAPERCLIP_BOARD_API_KEY";

  const company = await chooseCompany(companies, opts.companyId ?? resolvedProfile.profile.companyId, {
    optional: true,
  });
  const tokenName = opts.tokenName?.trim() || `cli-board-${new Date().toISOString()}`;
  const key = await boardApi.post<CreatedBoardKey>("/api/board-api-keys", createBoardApiKeySchema.parse({
    name: tokenName,
    requestedCompanyId: company?.id ?? null,
  }));
  if (!key) throw new Error("Failed to create board token");
  upsertProfile(profileName, {
    apiBase,
    companyId: company?.id,
    apiKeyEnvVarName,
    tokenName: key.name,
    tokenId: key.id,
    tokenCreatedAt: key.createdAt,
  }, opts.context);
  setCurrentProfile(profileName, opts.context);
  p.outro(pc.green(`Connected profile '${profileName}' as board.`));
  return {
    ok: true,
    profile: profileName,
    persona: "board",
    apiBase,
    companyId: company?.id ?? null,
    key: publicKeyResult(key),
    exports: buildExports({ apiBase, companyId: company?.id, envName: apiKeyEnvVarName, token: key.token }),
  };
}

async function verifyHealth(apiBase: string): Promise<void> {
  const api = new PaperclipApiClient({ apiBase });
  await api.get("/api/health");
}

async function askProfileName(defaultName: string): Promise<string> {
  const profile = await p.text({
    message: "Profile name",
    initialValue: defaultName || "default",
  });
  assertNotCancelled(profile);
  const value = String(profile).trim();
  if (!value) throw new Error("Profile name is required");
  return value;
}

async function chooseCompany(
  companies: Company[],
  preferredCompanyId: string | undefined,
  opts: { optional: boolean },
): Promise<Company | null> {
  if (companies.length === 0) {
    if (opts.optional) return null;
    throw new Error("No companies are accessible with this board credential.");
  }
  const preferred = preferredCompanyId ? companies.find((company) => company.id === preferredCompanyId) : null;
  if (companies.length === 1 && !opts.optional) return companies[0] ?? null;
  const selected = await p.select({
    message: opts.optional ? "Default company for this profile" : "Agent company",
    initialValue: preferred?.id ?? companies[0]?.id,
    options: [
      ...(opts.optional ? [{ value: "", label: "(none)" }] : []),
      ...companies.map((company) => ({
        value: company.id,
        label: company.name,
        hint: company.id,
      })),
    ],
  });
  assertNotCancelled(selected);
  if (!selected) return null;
  return companies.find((company) => company.id === selected) ?? null;
}

function buildExports(input: {
  apiBase: string;
  companyId?: string;
  envName: string;
  token: string;
}): string {
  const escaped = (value: string) => value.replace(/'/g, "'\"'\"'");
  return [
    `export PAPERCLIP_BOARD_API_URL='${escaped(input.apiBase)}'`,
    input.companyId ? `export PAPERCLIP_BOARD_COMPANY_ID='${escaped(input.companyId)}'` : null,
    `export ${input.envName}='${escaped(input.token)}'`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function publicKeyResult(key: CreatedBoardKey) {
  return {
    id: key.id,
    name: key.name,
    createdAt: key.createdAt,
    token: key.token,
    expiresAt: "expiresAt" in key ? key.expiresAt : undefined,
  };
}

function assertNotCancelled<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
}
