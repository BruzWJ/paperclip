import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import {
  isCanonicalUuid,
  parseExactPublicOrigin,
  parseOptionalExactNonEmptyEnvironmentValue,
} from "@paperclipai/shared";
import { parseExactApiBase } from "./api-base.js";
import { buildCliCommandLabel } from "./command-label.js";
import { resolveDefaultCliAuthPath } from "../config/home.js";

type RequestedAccess = "board" | "instance_admin_required";

interface BoardAuthCredential {
  apiBase: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  userId?: string | null;
}

interface BoardAuthStore {
  version: 1;
  credentials: Record<string, BoardAuthCredential>;
}

interface CreateChallengeResponse {
  id: string;
  token: string;
  boardApiToken: string;
  approvalPath: string;
  approvalUrl: string | null;
  pollPath: string;
  expiresAt: string;
  suggestedPollIntervalMs: number;
}

interface ChallengeStatusResponse {
  id: string;
  status: "pending" | "approved" | "cancelled" | "expired";
  command: string;
  clientName: string | null;
  requestedAccess: RequestedAccess;
  requestedCompanyId: string | null;
  requestedCompanyName: string | null;
  approvedAt: string | null;
  cancelledAt: string | null;
  expiresAt: string;
  approvedByUser: { id: string; name: string; email: string } | null;
}

function defaultBoardAuthStore(): BoardAuthStore {
  return {
    version: 1,
    credentials: {},
  };
}

function toExactNonBlankStringOrNull(value: unknown): string | null {
  return typeof value === "string" && /\S/.test(value) ? value : null;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error('PAPERCLIP_NO_BROWSER must be exactly "true" or "false"');
}

export function resolveBoardAuthStorePath(overridePath?: string): string {
  if (overridePath !== undefined) {
    if (overridePath.length === 0 || overridePath.trim() !== overridePath) {
      throw new Error(
        "Board auth store path must be non-empty and contain no surrounding whitespace",
      );
    }
    return path.resolve(overridePath);
  }
  const configuredPath = parseOptionalExactNonEmptyEnvironmentValue(
    process.env.PAPERCLIP_AUTH_STORE,
    "PAPERCLIP_AUTH_STORE",
  );
  if (configuredPath !== undefined) return path.resolve(configuredPath);
  return resolveDefaultCliAuthPath();
}

export function readBoardAuthStore(storePath?: string): BoardAuthStore {
  const filePath = resolveBoardAuthStorePath(storePath);
  if (!fs.existsSync(filePath)) return defaultBoardAuthStore();

  const raw = JSON.parse(
    fs.readFileSync(filePath, "utf8"),
  ) as Partial<BoardAuthStore> | null;
  const credentials =
    raw?.credentials && typeof raw.credentials === "object"
      ? raw.credentials
      : {};
  const validated: Record<string, BoardAuthCredential> = {};

  for (const [key, value] of Object.entries(credentials)) {
    if (typeof value !== "object" || value === null) continue;
    const record = value as unknown as Record<string, unknown>;
    const apiBase = typeof record.apiBase === "string" ? record.apiBase : null;
    const token = toExactNonBlankStringOrNull(record.token);
    const createdAt = toExactNonBlankStringOrNull(record.createdAt);
    const updatedAt = toExactNonBlankStringOrNull(record.updatedAt);
    if (!apiBase || !token || !createdAt || !updatedAt) continue;
    const canonicalApiBase = parseExactApiBase(key);
    if (apiBase !== canonicalApiBase) continue;
    validated[canonicalApiBase] = {
      apiBase,
      token,
      createdAt,
      updatedAt,
      userId: toExactNonBlankStringOrNull(record.userId),
    };
  }

  return {
    version: 1,
    credentials: validated,
  };
}

export function writeBoardAuthStore(
  store: BoardAuthStore,
  storePath?: string,
): void {
  const filePath = resolveBoardAuthStorePath(storePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function getStoredBoardCredential(
  apiBase: string,
  storePath?: string,
): BoardAuthCredential | null {
  const store = readBoardAuthStore(storePath);
  return store.credentials[parseExactApiBase(apiBase)] ?? null;
}

export function setStoredBoardCredential(input: {
  apiBase: string;
  token: string;
  userId?: string | null;
  storePath?: string;
}): BoardAuthCredential {
  const apiBase = parseExactApiBase(input.apiBase);
  const store = readBoardAuthStore(input.storePath);
  const now = new Date().toISOString();
  const existing = store.credentials[apiBase];
  const token = toExactNonBlankStringOrNull(input.token);
  if (!token) throw new Error("Board API token is required.");
  const userId =
    input.userId === null || input.userId === undefined
      ? input.userId
      : toExactNonBlankStringOrNull(input.userId);
  if (input.userId !== null && input.userId !== undefined && !userId) {
    throw new Error("Board user ID must be exact and non-blank.");
  }
  const credential: BoardAuthCredential = {
    apiBase,
    token,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    userId: userId ?? existing?.userId ?? null,
  };
  store.credentials[apiBase] = credential;
  writeBoardAuthStore(store, input.storePath);
  return credential;
}

export function removeStoredBoardCredential(
  apiBase: string,
  storePath?: string,
): boolean {
  const canonicalApiBase = parseExactApiBase(apiBase);
  const store = readBoardAuthStore(storePath);
  if (!store.credentials[canonicalApiBase]) return false;
  delete store.credentials[canonicalApiBase];
  writeBoardAuthStore(store, storePath);
  return true;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers ?? undefined);
  if (init?.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const message =
      body &&
      typeof body === "object" &&
      typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export async function openUrl(url: string): Promise<boolean> {
  const { command, args } =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };

  return new Promise<boolean>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function loginBoardCli(params: {
  apiBase: string;
  requestedAccess: RequestedAccess;
  requestedCompanyId?: string | null;
  clientName?: string | null;
  command?: string;
  storePath?: string;
  print?: boolean;
  openBrowser?: boolean;
  publicBaseUrl?: string;
}): Promise<{ token: string; approvalUrl: string; userId?: string | null }> {
  const apiBase = parseExactApiBase(params.apiBase);
  const createUrl = `${apiBase}/api/cli-auth/challenges`;
  const command = params.command ?? buildCliCommandLabel();
  const requestedCompanyId = params.requestedCompanyId ?? null;
  if (requestedCompanyId !== null && !isCanonicalUuid(requestedCompanyId)) {
    throw new Error(
      "CLI board authentication requires an exact canonical company UUID.",
    );
  }

  const challenge = await requestJson<CreateChallengeResponse>(createUrl, {
    method: "POST",
    headers: { origin: apiBase },
    body: JSON.stringify({
      command,
      clientName: params.clientName ?? "paperclipai cli",
      requestedAccess: params.requestedAccess,
      requestedCompanyId,
    }),
  });

  const explicitPublicBase =
    params.publicBaseUrl === undefined
      ? undefined
      : parseExactPublicOrigin(params.publicBaseUrl);
  const environmentPublicBase =
    process.env.PAPERCLIP_PUBLIC_URL === undefined
      ? undefined
      : parseExactPublicOrigin(process.env.PAPERCLIP_PUBLIC_URL);
  if (
    explicitPublicBase &&
    environmentPublicBase &&
    explicitPublicBase !== environmentPublicBase
  ) {
    throw new Error("CLI public base URL must match PAPERCLIP_PUBLIC_URL");
  }
  const publicBase = explicitPublicBase ?? environmentPublicBase;
  const approvalUrl = publicBase
    ? `${parseExactApiBase(publicBase)}${challenge.approvalPath}`
    : (challenge.approvalUrl ?? `${apiBase}${challenge.approvalPath}`);

  if (params.print !== false) {
    console.error(pc.bold("Board authentication required"));
    console.error(
      `Open this URL in your browser to approve CLI access:\n${approvalUrl}`,
    );
  }

  const wantBrowser =
    params.openBrowser !== false &&
    !isTruthyEnv(process.env.PAPERCLIP_NO_BROWSER);
  const opened = wantBrowser ? await openUrl(approvalUrl) : false;
  if (params.print !== false) {
    const browserMessage = !wantBrowser
      ? "Browser open skipped — open the URL above to approve."
      : opened
        ? "Opened the approval page in your browser."
        : "Couldn't open a browser automatically — open the URL above to approve.";
    console.error(pc.dim(browserMessage));
  }

  const expiresAtMs = Date.parse(challenge.expiresAt);
  const pollMs = Math.max(500, challenge.suggestedPollIntervalMs || 1000);

  while (Number.isFinite(expiresAtMs) ? Date.now() < expiresAtMs : true) {
    const status = await requestJson<ChallengeStatusResponse>(
      `${apiBase}/api${challenge.pollPath}?token=${encodeURIComponent(challenge.token)}`,
    );

    if (status.status === "approved") {
      const userId = toExactNonBlankStringOrNull(status.approvedByUser?.id);
      if (!userId) {
        throw new Error(
          "Approved CLI auth challenge did not include its user ID.",
        );
      }
      setStoredBoardCredential({
        apiBase,
        token: challenge.boardApiToken,
        userId,
        storePath: params.storePath,
      });
      return {
        token: challenge.boardApiToken,
        approvalUrl,
        userId,
      };
    }

    if (status.status === "cancelled") {
      throw new Error("CLI auth challenge was cancelled.");
    }
    if (status.status === "expired") {
      throw new Error("CLI auth challenge expired before approval.");
    }

    await sleep(pollMs);
  }

  throw new Error("CLI auth challenge expired before approval.");
}

export async function revokeStoredBoardCredential(params: {
  apiBase: string;
  token: string;
}): Promise<void> {
  const apiBase = parseExactApiBase(params.apiBase);
  await requestJson<{ revoked: boolean }>(
    `${apiBase}/api/cli-auth/revoke-current`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({}),
    },
  );
}
