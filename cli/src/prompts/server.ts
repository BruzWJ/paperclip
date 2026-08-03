import * as p from "@clack/prompts";
import { isLoopbackHost, normalizePublicOrigin, type BindMode } from "@paperclipai/shared";
import type { AuthConfig, ServerConfig } from "../config/schema.js";
import { parseHostnameCsv } from "../config/hostnames.js";
import { buildCustomServerConfig, buildPresetServerConfig, inferConfiguredBind } from "../config/server-bind.js";

const TAILNET_BIND_WARNING =
  "No Tailscale address was detected during setup. The saved config will stay on loopback until Tailscale is available or PAPERCLIP_TAILNET_BIND_HOST is set.";

function cancelled(): never {
  p.cancel("Setup cancelled.");
  process.exit(0);
}

export async function promptServer(opts?: {
  currentServer?: Partial<ServerConfig>;
  currentAuth?: Partial<AuthConfig>;
}): Promise<{ server: ServerConfig; auth: AuthConfig }> {
  const currentServer = opts?.currentServer;
  const currentAuth = opts?.currentAuth;
  const currentBind = inferConfiguredBind(currentServer);

  const bindSelection = await p.select({
    message: "Reachability",
    options: [
      {
        value: "loopback" as const,
        label: "This machine",
        hint: "Recommended for first run: loopback-only access",
      },
      {
        value: "lan" as const,
        label: "Private network",
        hint: "Broad private bind for LAN, VPN, or legacy --tailscale-auth style access",
      },
      {
        value: "tailnet" as const,
        label: "Tailnet",
        hint: "Private access using the machine's detected Tailscale address",
      },
      {
        value: "custom" as const,
        label: "Custom",
        hint: "Choose exact exposure and host manually",
      },
    ],
    initialValue: currentBind,
  });

  if (p.isCancel(bindSelection)) cancelled();
  const bind = bindSelection as BindMode;

  const portStr = await p.text({
    message: "Server port",
    defaultValue: String(currentServer?.port ?? 3100),
    placeholder: "3100",
    validate: (val) => {
      const n = Number(val);
      if (isNaN(n) || n < 1 || n > 65535 || !Number.isInteger(n)) {
        return "Must be an integer between 1 and 65535";
      }
    },
  });

  if (p.isCancel(portStr)) cancelled();
  const port = Number(portStr) || 3100;
  const serveUi = currentServer?.serveUi ?? true;

  if (bind === "loopback") {
    return buildPresetServerConfig("loopback", {
      port,
      allowedHostnames: [],
      serveUi,
    });
  }

  if (bind === "lan" || bind === "tailnet") {
    const allowedHostnamesInput = await p.text({
      message: "Allowed private hostnames (comma-separated, optional)",
      defaultValue: (currentServer?.allowedHostnames ?? []).join(", "),
      placeholder:
        bind === "tailnet"
          ? "your-machine.tailnet.ts.net"
          : "dotta-macbook-pro, host.docker.internal",
      validate: (val) => {
        try {
          parseHostnameCsv(val);
          return;
        } catch (err) {
          return err instanceof Error ? err.message : "Invalid hostname list";
        }
      },
    });

    if (p.isCancel(allowedHostnamesInput)) cancelled();

    const preset = buildPresetServerConfig(bind, {
      port,
      allowedHostnames: parseHostnameCsv(allowedHostnamesInput),
      serveUi,
    });
    if (bind === "tailnet" && isLoopbackHost(preset.server.host)) {
      p.log.warn(TAILNET_BIND_WARNING);
    }
    return preset;
  }

  const exposureSelection = await p.select({
    message: "Exposure profile",
    options: [
      {
        value: "private",
        label: "Private network",
        hint: "Private access only, with automatic URL handling",
      },
      {
        value: "public",
        label: "Public internet",
        hint: "Internet-facing deployment with explicit public URL requirements",
      },
    ],
    initialValue: currentServer?.exposure ?? "private",
  });

  if (p.isCancel(exposureSelection)) cancelled();
  const exposure = exposureSelection as ServerConfig["exposure"];

  const defaultHost =
    currentServer?.customBindHost ??
    currentServer?.host ??
    (exposure === "public" ? "0.0.0.0" : "127.0.0.1");
  const host = await p.text({
    message: "Bind host",
    defaultValue: defaultHost,
    placeholder: defaultHost,
    validate: (val) => {
      if (!val.trim()) return "Host is required";
    },
  });

  if (p.isCancel(host)) cancelled();

  let allowedHostnames: string[] = [];
  if (exposure === "private") {
    const allowedHostnamesInput = await p.text({
      message: "Allowed private hostnames (comma-separated, optional)",
      defaultValue: (currentServer?.allowedHostnames ?? []).join(", "),
      placeholder: "dotta-macbook-pro, your-host.tailnet.ts.net",
      validate: (val) => {
        try {
          parseHostnameCsv(val);
          return;
        } catch (err) {
          return err instanceof Error ? err.message : "Invalid hostname list";
        }
      },
    });

    if (p.isCancel(allowedHostnamesInput)) cancelled();
    allowedHostnames = parseHostnameCsv(allowedHostnamesInput);
  }

  let publicBaseUrl: string | undefined;
  if (exposure === "public") {
    const urlInput = await p.text({
      message: "Public base URL",
      defaultValue: currentAuth?.publicBaseUrl ?? "",
      placeholder: "https://paperclip.example.com",
      validate: (val) => {
        const candidate = val.trim();
        if (!candidate) return "Public HTTPS origin is required for public exposure";
        try {
          normalizePublicOrigin(candidate);
          return;
        } catch (error) {
          return error instanceof Error ? error.message : "Enter a valid origin";
        }
      },
    });
    if (p.isCancel(urlInput)) cancelled();
    publicBaseUrl = normalizePublicOrigin(urlInput);
  }

  return buildCustomServerConfig({
    exposure,
    host: host.trim(),
    port,
    allowedHostnames,
    serveUi,
    publicBaseUrl,
  });
}
