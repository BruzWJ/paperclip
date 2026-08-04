import { Command } from "commander";
import { createBoardApiKeySchema } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  apiPath,
  formatInlineRecord,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface BoardTokenOptions extends BaseClientOptions {
  companyId?: string;
  name?: string;
  expiresAt?: string;
  ttlDays?: string;
  neverExpires?: boolean;
}

interface CreatedBoardKey {
  id: string;
  name: string;
  token: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

interface BoardKeyRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

export function registerTokenCommands(program: Command): void {
  const token = program.command("token").description("Manage Paperclip API tokens");

  const board = token.command("board").description("Manage board API keys");

  addCommonClientOptions(
    board
      .command("create")
      .description("Create a named board API key")
      .option("-C, --company-id <id>", "Company ID used for audit context")
      .option("--name <name>", "API key label", "cli-board")
      .option("--expires-at <iso8601>", "Expiration timestamp")
      .option("--ttl-days <days>", "Expiration in days from now")
      .option("--never-expires", "Create a non-expiring key")
      .action(async (opts: BoardTokenOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const expiresAt = resolveBoardKeyExpiresAt(opts);
          const payload = createBoardApiKeySchema.parse({
            name: opts.name,
            requestedCompanyId: opts.companyId ?? ctx.companyId ?? null,
            expiresAt,
          });
          const key = await ctx.api.post<CreatedBoardKey>("/api/board-api-keys", payload);
          if (!key) throw new Error("Failed to create board API key");
          printOutput({ key }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    board
      .command("list")
      .description("List board API keys for the current board user")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const keys = (await ctx.api.get<BoardKeyRow[]>("/api/board-api-keys")) ?? [];
          if (ctx.json) {
            printOutput(keys, { json: true });
            return;
          }
          for (const key of keys) {
            console.log(formatInlineRecord({
              id: key.id,
              name: key.name,
              createdAt: key.createdAt,
              lastUsedAt: key.lastUsedAt,
              expiresAt: key.expiresAt,
              revokedAt: key.revokedAt,
            }));
          }
          if (keys.length === 0) printOutput([], { json: false });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    board
      .command("revoke")
      .description("Revoke a board API key")
      .argument("<keyId>", "Board API key ID")
      .action(async (keyId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.delete<{ ok: true; keyId: string }>(apiPath`/api/board-api-keys/${keyId}`);
          printOutput(result ?? { ok: true, keyId }, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}

function resolveBoardKeyExpiresAt(opts: BoardTokenOptions): Date | null | undefined {
  if (opts.neverExpires) return null;
  if (opts.expiresAt?.trim()) {
    const date = new Date(opts.expiresAt.trim());
    if (!Number.isFinite(date.getTime())) throw new Error(`Invalid --expires-at value: ${opts.expiresAt}`);
    return date;
  }
  if (opts.ttlDays?.trim()) {
    const days = Number(opts.ttlDays);
    if (!Number.isFinite(days) || days <= 0) throw new Error(`Invalid --ttl-days value: ${opts.ttlDays}`);
    return new Date(Date.now() + Math.floor(days * 24 * 60 * 60 * 1000));
  }
  return undefined;
}
