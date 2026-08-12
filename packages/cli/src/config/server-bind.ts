import { execFileSync } from "node:child_process";
import {
  isAllInterfacesHost,
  isLoopbackHost,
  parseExactPublicOrigin,
  parseOptionalExactNonEmptyEnvironmentValue,
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

export function detectTailnetBindHost(): string | undefined {
  const explicit = parseOptionalExactNonEmptyEnvironmentValue(
    process.env.PAPERCLIP_TAILNET_BIND_HOST,
    "PAPERCLIP_TAILNET_BIND_HOST",
  );
  if (explicit !== undefined) return explicit;

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
  return {
    server: {
      exposure: "private",
      bind,
      port: input.port,
      allowedHostnames: input.allowedHostnames,
      serveUi: input.serveUi,
    },
    auth: {
      disableSignUp: false,
    },
  };
}

export function buildCustomServerConfig(
  input: BaseServerInput & {
    exposure: DeploymentExposure;
    customBindHost: string;
    publicBaseUrl?: string;
  },
): { server: ServerConfig; auth: AuthConfig } {
  const normalizedHost = input.customBindHost.trim();
  if (!normalizedHost) {
    throw new Error("Bind host is required");
  }
  if (normalizedHost !== input.customBindHost) {
    throw new Error("Custom bind host must not contain surrounding whitespace");
  }
  if (isLoopbackHost(normalizedHost)) {
    throw new Error(
      "Use the loopback bind mode instead of a loopback custom bind host",
    );
  }
  if (isAllInterfacesHost(normalizedHost)) {
    throw new Error(
      "Use the lan bind mode instead of an all-interfaces custom bind host",
    );
  }
  const publicBaseUrl = input.publicBaseUrl
    ? parseExactPublicOrigin(input.publicBaseUrl)
    : undefined;
  if (input.exposure === "public" && !publicBaseUrl) {
    throw new Error(
      "auth.publicBaseUrl is required when server.exposure=public",
    );
  }
  return {
    server: {
      exposure: input.exposure,
      bind: "custom",
      customBindHost: normalizedHost,
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
