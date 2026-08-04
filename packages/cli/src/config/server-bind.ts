import { execFileSync } from "node:child_process";
import {
  ALL_INTERFACES_BIND_HOST,
  LOOPBACK_BIND_HOST,
  inferBindModeFromHost,
  isAllInterfacesHost,
  isLoopbackHost,
  normalizePublicOrigin,
  type BindMode,
  type DeploymentExposure,
} from "@paperclipai/shared";
import type { AuthConfig, ServerConfig } from "./schema.js";

const TAILSCALE_DETECT_TIMEOUT_MS = 3000;

type BaseServerInput = {
  port: number;
  allowedHostnames: string[];
  serveUi: boolean;
};

export function inferConfiguredBind(server?: Partial<ServerConfig>): BindMode {
  if (server?.bind) return server.bind;
  return inferBindModeFromHost(server?.customBindHost ?? server?.host);
}

export function detectTailnetBindHost(): string | undefined {
  const explicit = process.env.PAPERCLIP_TAILNET_BIND_HOST?.trim();
  if (explicit) return explicit;

  try {
    const stdout = execFileSync("tailscale", ["ip", "-4"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: TAILSCALE_DETECT_TIMEOUT_MS,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

export function buildPresetServerConfig(
  bind: Exclude<BindMode, "custom">,
  input: BaseServerInput,
): { server: ServerConfig; auth: AuthConfig } {
  const host =
    bind === "loopback"
      ? LOOPBACK_BIND_HOST
      : bind === "tailnet"
        ? (detectTailnetBindHost() ?? LOOPBACK_BIND_HOST)
        : ALL_INTERFACES_BIND_HOST;

  return {
    server: {
      exposure: "private",
      bind,
      customBindHost: undefined,
      host,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    },
    auth: {
      disableSignUp: false,
    },
  };
}

export function buildCustomServerConfig(input: BaseServerInput & {
  exposure: DeploymentExposure;
  host: string;
  publicBaseUrl?: string;
}): { server: ServerConfig; auth: AuthConfig } {
  const normalizedHost = input.host.trim();
  const publicBaseUrl = input.publicBaseUrl
    ? normalizePublicOrigin(input.publicBaseUrl)
    : undefined;
  if (input.exposure === "public" && !publicBaseUrl) {
    throw new Error(
      "auth.publicBaseUrl is required when server.exposure=public",
    );
  }
  const bind = isLoopbackHost(normalizedHost)
    ? "loopback"
    : isAllInterfacesHost(normalizedHost)
      ? "lan"
      : "custom";

  return {
    server: {
      exposure: input.exposure,
      bind,
      customBindHost: bind === "custom" ? normalizedHost : undefined,
      host: normalizedHost,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    },
    auth:
      input.exposure === "public"
        ? {
          disableSignUp: false,
          publicBaseUrl,
        }
        : {
          disableSignUp: false,
        },
  };
}

export function resolveQuickstartServerConfig(input: {
  bind?: BindMode | null;
  exposure?: DeploymentExposure | null;
  host?: string | null;
  port: number;
  allowedHostnames: string[];
  serveUi: boolean;
  publicBaseUrl?: string;
}): { server: ServerConfig; auth: AuthConfig } {
  const trimmedHost = input.host?.trim();
  const explicitBind = input.bind ?? null;

  if (explicitBind === "tailnet" && input.exposure === "public") {
    throw new Error(
      "server.bind=tailnet is only supported when server.exposure=private",
    );
  }

  if (
    (explicitBind === "loopback" || explicitBind === "lan" || explicitBind === "tailnet") &&
    input.exposure !== "public"
  ) {
    return buildPresetServerConfig(explicitBind, {
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    });
  }

  if (explicitBind === "custom") {
    return buildCustomServerConfig({
      exposure: input.exposure ?? "private",
      host: trimmedHost || LOOPBACK_BIND_HOST,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
      publicBaseUrl: input.publicBaseUrl,
    });
  }

  if (trimmedHost) {
    return buildCustomServerConfig({
      exposure: input.exposure ?? "private",
      host: trimmedHost,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
      publicBaseUrl: input.publicBaseUrl,
    });
  }

  if (input.exposure === "public") {
    return buildCustomServerConfig({
      exposure: "public",
      host:
        explicitBind === "loopback"
          ? LOOPBACK_BIND_HOST
          : explicitBind === "tailnet"
            ? (detectTailnetBindHost() ?? LOOPBACK_BIND_HOST)
            : ALL_INTERFACES_BIND_HOST,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
      publicBaseUrl: input.publicBaseUrl,
    });
  }

  return buildPresetServerConfig("loopback", {
    port: input.port,
    allowedHostnames: input.allowedHostnames,
    serveUi: input.serveUi,
  });
}
