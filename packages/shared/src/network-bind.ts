import type { BindMode, DeploymentExposure } from "./constants.js";

export const LOOPBACK_BIND_HOST = "127.0.0.1";
export const ALL_INTERFACES_BIND_HOST = "0.0.0.0";
export const DEFAULT_SERVER_PORT = 3100;

function invalidHostname(value: string): Error {
  return new Error(
    `Invalid hostname '${value}': expected one exact lowercase hostname without a scheme, port, path, or surrounding whitespace`,
  );
}

export function parseExactHostname(value: string): string {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.toLowerCase() !== value ||
    value.endsWith(".") ||
    /[\u0000-\u0020\u007f/@\\?#,%\[\]]/.test(value)
  ) {
    throw invalidHostname(value);
  }

  if (value.includes(":")) {
    try {
      const parsed = new URL(`http://[${value}]`);
      const canonical = parsed.hostname.slice(1, -1);
      if (canonical !== value) throw invalidHostname(value);
      return value;
    } catch {
      throw invalidHostname(value);
    }
  }

  if (
    value.length > 253 ||
    (/^[0-9.]+$/.test(value) && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value))
  ) {
    throw invalidHostname(value);
  }

  const labels = value.split(".");
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  ) {
    throw invalidHostname(value);
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split(".");
    if (
      octets.some(
        (octet) =>
          Number(octet) > 255 || (octet.length > 1 && octet.startsWith("0")),
      )
    ) {
      throw invalidHostname(value);
    }
  }

  return value;
}

export function parseExactHostnameList(values: readonly string[]): string[] {
  const parsed = values.map(parseExactHostname);
  if (new Set(parsed).size !== parsed.length) {
    throw new Error("Hostname list must not contain duplicates");
  }
  return parsed;
}

export function parseExactHostnameCsv(value: string): string[] {
  if (value === "") return [];
  return parseExactHostnameList(value.split(","));
}

export function parseExactNonEmptyHostnameCsv(value: string): string[] {
  const parsed = parseExactHostnameCsv(value);
  if (parsed.length === 0) {
    throw new Error("Hostname list must contain at least one exact hostname");
  }
  return parsed;
}

export function resolveServerPort(input: {
  environmentValue?: string;
  persistedValue?: number;
}): number {
  if (input.environmentValue !== undefined) {
    if (!/^[1-9]\d*$/.test(input.environmentValue)) {
      throw new Error(
        "PORT must be an integer from 1 through 65535 with no whitespace or leading zeros",
      );
    }
    const port = Number(input.environmentValue);
    if (!Number.isSafeInteger(port) || port > 65_535) {
      throw new Error(
        "PORT must be an integer from 1 through 65535 with no whitespace or leading zeros",
      );
    }
    return port;
  }

  if (input.persistedValue !== undefined) {
    if (
      !Number.isInteger(input.persistedValue) ||
      input.persistedValue < 1 ||
      input.persistedValue > 65_535
    ) {
      throw new Error("server.port must be an integer from 1 through 65535");
    }
    return input.persistedValue;
  }

  return DEFAULT_SERVER_PORT;
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function isAllInterfacesHost(host: string | null | undefined): boolean {
  return host === "0.0.0.0" || host === "::";
}

export function validateConfiguredBindMode(input: {
  exposure: DeploymentExposure;
  bind: BindMode;
  customBindHost?: string | null | undefined;
}): string[] {
  const customBindHost = input.customBindHost;
  const errors: string[] = [];

  if (
    customBindHost !== undefined &&
    (customBindHost === null ||
      customBindHost.length === 0 ||
      customBindHost.trim() !== customBindHost)
  ) {
    errors.push("server.customBindHost must be exact and non-empty");
    return errors;
  }

  if (customBindHost) {
    try {
      parseExactHostname(customBindHost);
    } catch {
      errors.push(
        "server.customBindHost must be one exact lowercase hostname or IP address",
      );
      return errors;
    }
  }

  if (input.bind === "custom") {
    if (!customBindHost) {
      errors.push("server.customBindHost is required when server.bind=custom");
    } else if (isLoopbackHost(customBindHost)) {
      errors.push(
        "Use server.bind=loopback instead of a loopback server.customBindHost",
      );
    } else if (isAllInterfacesHost(customBindHost)) {
      errors.push(
        "Use server.bind=lan instead of an all-interfaces server.customBindHost",
      );
    }
  } else if (customBindHost) {
    errors.push("server.customBindHost is only valid when server.bind=custom");
  }

  if (input.exposure === "public" && input.bind === "tailnet") {
    errors.push(
      "server.bind=tailnet is only supported when server.exposure=private",
    );
  }

  return errors;
}

export function resolveRuntimeBind(input: {
  exposure: DeploymentExposure;
  bind: BindMode;
  customBindHost?: string | null | undefined;
  tailnetBindHost?: string | null | undefined;
}): {
  bind: BindMode;
  host: string;
  customBindHost?: string;
} {
  const customBindHost = input.customBindHost ?? undefined;
  const errors = validateConfiguredBindMode({
    exposure: input.exposure,
    bind: input.bind,
    customBindHost,
  });
  if (errors.length > 0) throw new Error(errors[0]);

  switch (input.bind) {
    case "loopback":
      return { bind: input.bind, host: LOOPBACK_BIND_HOST };
    case "lan":
      return { bind: input.bind, host: ALL_INTERFACES_BIND_HOST };
    case "custom": {
      return {
        bind: input.bind,
        host: customBindHost!,
        customBindHost: customBindHost!,
      };
    }
    case "tailnet": {
      const tailnetBindHost = input.tailnetBindHost;
      if (
        tailnetBindHost === undefined ||
        tailnetBindHost === null ||
        tailnetBindHost.length === 0 ||
        tailnetBindHost.trim() !== tailnetBindHost
      ) {
        throw new Error(
          "server.bind=tailnet requires one exact detected Tailscale address or PAPERCLIP_TAILNET_BIND_HOST",
        );
      }
      parseExactHostname(tailnetBindHost);
      return { bind: input.bind, host: tailnetBindHost };
    }
  }
}
