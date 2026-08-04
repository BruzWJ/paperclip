import { isIP } from "node:net";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { RequestHandler } from "express";
import {
  normalizePublicOrigin,
  type DeploymentExposure,
} from "@paperclipai/shared";

export type RequestScheme = "http" | "https";

export interface RequestAuthority {
  scheme: RequestScheme;
  hostname: string;
  port: number | null;
  authority: string;
  origin: string;
  immediatePeerTrusted: boolean;
}

export type TrustProxyPredicate = (address: string, hop: number) => boolean;

export interface RequestAuthorityPolicy {
  deploymentExposure: DeploymentExposure;
  canonicalPublicOrigin: string | null;
  privateAllowedHostnames: ReadonlySet<string>;
}

type AuthorityCarrier = IncomingMessage & {
  requestAuthority?: RequestAuthority;
};

export class RequestAuthorityError extends Error {
  readonly status: 400 | 403;

  constructor(message: string, status: 400 | 403 = 400) {
    super(message);
    this.name = "RequestAuthorityError";
    this.status = status;
  }
}

function invalidAuthority(message: string): never {
  throw new RequestAuthorityError(message);
}

function readHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    if (raw.length !== 1) invalidAuthority(`Multiple ${name} headers are not allowed`);
    return raw[0];
  }
  return raw;
}

function parseForwardedValues(raw: string, name: string): string[] {
  const values = raw.split(",").map((value) => value.trim());
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    invalidAuthority(`Malformed ${name} header`);
  }
  return values;
}

function normalizeDomainHostname(raw: string): string {
  const hostname = raw.toLowerCase();
  if (/^[0-9.]+$/.test(hostname)) {
    invalidAuthority("Host contains a non-canonical IPv4 address");
  }
  if (hostname.length > 253) invalidAuthority("Host hostname is too long");
  const labelSource = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (!labelSource) invalidAuthority("Host hostname is empty");
  for (const label of labelSource.split(".")) {
    if (
      label.length === 0
      || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    ) {
      invalidAuthority("Host contains an invalid hostname");
    }
  }
  return hostname;
}

function normalizeIpv6Hostname(raw: string): string {
  if (isIP(raw) !== 6) invalidAuthority("Host contains an invalid IPv6 address");
  return new URL(`http://[${raw}]`).hostname.slice(1, -1).toLowerCase();
}

function normalizeHostname(raw: string): string {
  if (isIP(raw) === 4) return raw;
  return normalizeDomainHostname(raw);
}

function parsePort(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d{1,5}$/.test(raw)) invalidAuthority("Host contains an invalid port");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    invalidAuthority("Host contains an invalid port");
  }
  return port;
}

export function canonicalizeAuthority(
  rawAuthority: string,
  scheme: RequestScheme,
): Omit<RequestAuthority, "immediatePeerTrusted"> {
  if (!rawAuthority || rawAuthority !== rawAuthority.trim()) {
    invalidAuthority("Host header is missing or malformed");
  }
  if (
    /[\u0000-\u0020\u007f]/.test(rawAuthority)
    || /[@/\\?#,%]/.test(rawAuthority)
  ) {
    invalidAuthority("Host header is malformed");
  }

  let hostname: string;
  let rawPort: string | undefined;
  if (rawAuthority.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(rawAuthority);
    if (!match) invalidAuthority("Host header contains malformed IPv6 authority");
    hostname = normalizeIpv6Hostname(match[1]!);
    rawPort = match[2];
  } else {
    const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(rawAuthority);
    if (!match) invalidAuthority("Host header contains malformed authority");
    hostname = normalizeHostname(match[1]!);
    rawPort = match[2];
  }

  const parsedPort = parsePort(rawPort);
  const port =
    (scheme === "http" && parsedPort === 80)
    || (scheme === "https" && parsedPort === 443)
      ? null
      : parsedPort;
  const formattedHostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const authority = port === null ? formattedHostname : `${formattedHostname}:${port}`;
  return {
    scheme,
    hostname,
    port,
    authority,
    origin: `${scheme}://${authority}`,
  };
}

export function canonicalizeBrowserOrigin(
  value: string | undefined,
  options: { allowPath?: boolean } = {},
): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || (!options.allowPath && (url.pathname !== "/" || url.search || url.hash))
    ) {
      return null;
    }
    return canonicalizeAuthority(
      url.host,
      url.protocol.slice(0, -1) as RequestScheme,
    ).origin;
  } catch {
    return null;
  }
}

function resolveImmediatePeerTrust(
  req: IncomingMessage,
  trustProxy: TrustProxyPredicate,
): boolean {
  const remoteAddress = req.socket?.remoteAddress;
  if (!remoteAddress) return false;
  try {
    return trustProxy(remoteAddress, 0) === true;
  } catch {
    return false;
  }
}

export function resolveRequestAuthority(
  req: IncomingMessage,
  trustProxy: TrustProxyPredicate,
): RequestAuthority {
  const carrier = req as AuthorityCarrier;
  if (carrier.requestAuthority) return carrier.requestAuthority;

  const socketScheme: RequestScheme =
    (req.socket as typeof req.socket & { encrypted?: boolean })?.encrypted === true
      ? "https"
      : "http";
  const hostHeader = readHeader(req.headers, "host");
  if (!hostHeader) invalidAuthority("Missing Host header");
  // Validate the actual inbound authority even when a trusted proxy supplies
  // the client-facing authority used below.
  canonicalizeAuthority(hostHeader, socketScheme);

  const immediatePeerTrusted = resolveImmediatePeerTrust(req, trustProxy);
  let scheme = socketScheme;
  let effectiveHost = hostHeader;
  if (immediatePeerTrusted) {
    const forwardedProto = readHeader(req.headers, "x-forwarded-proto");
    if (forwardedProto !== undefined) {
      const values = parseForwardedValues(forwardedProto, "x-forwarded-proto");
      for (const value of values) {
        if (value.toLowerCase() !== "http" && value.toLowerCase() !== "https") {
          invalidAuthority("x-forwarded-proto must contain only http or https");
        }
      }
      scheme = values[0]!.toLowerCase() as RequestScheme;
    }

    const forwardedHost = readHeader(req.headers, "x-forwarded-host");
    if (forwardedHost !== undefined) {
      const values = parseForwardedValues(forwardedHost, "x-forwarded-host");
      for (const value of values) canonicalizeAuthority(value, scheme);
      effectiveHost = values[0]!;
    }
  }

  const authority = {
    ...canonicalizeAuthority(effectiveHost, scheme),
    immediatePeerTrusted,
  };
  carrier.requestAuthority = authority;
  return authority;
}

function canonicalizeConfiguredHostname(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) invalidAuthority("Configured hostname cannot be empty");
  if (value.startsWith("[") && value.endsWith("]")) {
    return normalizeIpv6Hostname(value.slice(1, -1));
  }
  if (isIP(value) === 6) return normalizeIpv6Hostname(value);
  return normalizeHostname(value);
}

export function resolvePrivateHostnameAllowSet(opts: {
  allowedHostnames: string[];
  bindHost: string;
}): Set<string> {
  const allowSet = new Set<string>();
  for (const configured of opts.allowedHostnames) {
    if (!configured.trim()) continue;
    allowSet.add(canonicalizeConfiguredHostname(configured));
  }

  const bindHost = opts.bindHost.trim();
  if (bindHost && bindHost !== "0.0.0.0" && bindHost !== "::") {
    allowSet.add(canonicalizeConfiguredHostname(bindHost));
  }
  allowSet.add("localhost");
  allowSet.add("127.0.0.1");
  allowSet.add("::1");
  return allowSet;
}

export function createRequestAuthorityPolicy(input: {
  deploymentExposure: DeploymentExposure;
  canonicalPublicUrl?: string;
  allowedHostnames: string[];
  bindHost: string;
}): RequestAuthorityPolicy {
  const canonicalPublicOrigin = input.canonicalPublicUrl
    ? normalizePublicOrigin(input.canonicalPublicUrl)
    : null;
  if (input.deploymentExposure === "public" && !canonicalPublicOrigin) {
    throw new Error("Public exposure requires one canonical public origin");
  }
  if (input.deploymentExposure === "private" && canonicalPublicOrigin) {
    throw new Error("Private exposure cannot configure a public origin");
  }
  return {
    deploymentExposure: input.deploymentExposure,
    canonicalPublicOrigin,
    privateAllowedHostnames:
      input.deploymentExposure === "private"
        ? resolvePrivateHostnameAllowSet({
          allowedHostnames: input.allowedHostnames,
          bindHost: input.bindHost,
        })
        : new Set(),
  };
}

export function assertRequestAuthorityAllowed(
  authority: RequestAuthority,
  policy: RequestAuthorityPolicy,
): void {
  if (policy.deploymentExposure === "public") {
    if (!policy.canonicalPublicOrigin || authority.origin !== policy.canonicalPublicOrigin) {
      throw new RequestAuthorityError(
        "Request authority does not match the canonical public origin",
        403,
      );
    }
    return;
  }

  if (!policy.privateAllowedHostnames.has(authority.hostname)) {
    throw new RequestAuthorityError(
      `Hostname '${authority.hostname}' is not allowed for this Paperclip instance. `
        + `If you want to allow this hostname, please run pnpm paperclipai allowed-hostname ${authority.hostname}`,
      403,
    );
  }
}

const RAW_AUTHORITY_HEADERS = new Set([
  ":authority",
  "forwarded",
  "host",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);

export function canonicalRequestHeaders(
  rawHeaders: IncomingHttpHeaders,
  authority: RequestAuthority,
): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(rawHeaders)) {
    if (raw === undefined || RAW_AUTHORITY_HEADERS.has(name.toLowerCase())) continue;
    if (Array.isArray(raw)) {
      for (const value of raw) headers.append(name, value);
    } else {
      headers.set(name, raw);
    }
  }
  headers.set("host", authority.authority);
  // better-call's Node bridge needs an explicit scheme. This value is derived
  // by Paperclip's trusted boundary, never copied from the inbound header.
  headers.set("x-forwarded-proto", authority.scheme);
  return headers;
}

export function canonicalNodeRequestHeaders(
  rawHeaders: IncomingHttpHeaders,
  authority: RequestAuthority,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of canonicalRequestHeaders(rawHeaders, authority)) {
    headers[name] = value;
  }
  return headers;
}

export interface RequestAuthorityBoundary {
  readonly policy: RequestAuthorityPolicy;
  resolve(req: IncomingMessage): RequestAuthority;
  admit(req: IncomingMessage): RequestAuthority;
  headers(req: IncomingMessage): Headers;
  middleware: RequestHandler;
}

export function createRequestAuthorityBoundary(input: {
  trustProxy: TrustProxyPredicate;
  policy: RequestAuthorityPolicy;
}): RequestAuthorityBoundary {
  const resolve = (req: IncomingMessage) => resolveRequestAuthority(req, input.trustProxy);
  const admit = (req: IncomingMessage) => {
    const authority = resolve(req);
    assertRequestAuthorityAllowed(authority, input.policy);
    return authority;
  };
  const middleware: RequestHandler = (req, res, next) => {
    try {
      admit(req);
      next();
    } catch (error) {
      if (!(error instanceof RequestAuthorityError)) {
        next(error);
        return;
      }
      const wantsJson =
        req.originalUrl.startsWith("/api")
        || req.accepts(["json", "html", "text"]) === "json";
      if (wantsJson) {
        res.status(error.status).json({ error: error.message });
      } else {
        res.status(error.status).type("text/plain").send(error.message);
      }
    }
  };
  return {
    policy: input.policy,
    resolve,
    admit,
    headers(req) {
      return canonicalRequestHeaders(req.headers, resolve(req));
    },
    middleware,
  };
}

export function requireRequestAuthority(req: IncomingMessage): RequestAuthority {
  const authority = (req as AuthorityCarrier).requestAuthority;
  if (!authority) {
    throw new Error("Request authority middleware must run before this consumer");
  }
  return authority;
}
