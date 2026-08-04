import { inferBindModeFromHost, normalizePublicOrigin } from "@paperclipai/shared";
import type { PaperclipConfig } from "../config/schema.js";
import type { CheckResult } from "./index.js";

export function authCheck(config: PaperclipConfig): CheckResult {
  const exposure = config.server.exposure;
  const auth = config.auth;
  const bind = config.server.bind ?? inferBindModeFromHost(config.server.host);

  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) {
    return {
      name: "Authentication",
      status: "fail",
      message: "BETTER_AUTH_SECRET is required",
      guidance: "Set BETTER_AUTH_SECRET before starting Paperclip",
    };
  }

  if (exposure === "public") {
    if (!auth.publicBaseUrl) {
      return {
        name: "Authentication",
        status: "fail",
        message: "Public exposure requires auth.publicBaseUrl",
        guidance: "Run `paperclipai configure --section server` and select public exposure",
      };
    }
    try {
      normalizePublicOrigin(auth.publicBaseUrl);
    } catch (error) {
      return {
        name: "Authentication",
        status: "fail",
        message: error instanceof Error
          ? `Invalid auth.publicBaseUrl: ${error.message}`
          : "auth.publicBaseUrl is not a valid HTTPS origin",
        guidance: "Run `paperclipai configure --section server` and provide an exact HTTPS origin without credentials, a path, query, or fragment",
      };
    }
  }

  if (exposure === "private" && auth.publicBaseUrl) {
    return {
      name: "Authentication",
      status: "fail",
      message: "Private exposure derives its auth origin from each request",
      guidance: "Remove auth.publicBaseUrl or select public exposure",
    };
  }

  return {
    name: "Authentication",
    status: "pass",
    message: exposure === "public"
      ? `Better Auth configured for public exposure at ${auth.publicBaseUrl}`
      : `Better Auth configured for private ${bind} access with request-derived origin`,
  };
}
