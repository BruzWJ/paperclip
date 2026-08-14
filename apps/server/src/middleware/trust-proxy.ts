import { isIP } from "node:net";

/**
 * Parser for the `TRUST_PROXY` env var, which mirrors Express 5's
 * `trust proxy` setting. The default is intentionally *unset* — Express
 * then trusts nothing and `req.ip` / `X-Forwarded-For` cannot be spoofed
 * by arbitrary clients. Operators opt in only when there is a real LB
 * in front of the server.
 *
 * Accepted forms (case-sensitive for the keywords, matching Express):
 *
 *   unset                   -> undefined (caller skips `app.set`)
 *   "true"                  -> true   (UNSAFE behind untrusted LBs)
 *   "<positive integer>"    -> number (trust N hops)
 *   comma-separated tokens  -> string[] of named subnets + IP/CIDR values
 *
 * There are deliberately no disabled-value or whitespace aliases. Omit the
 * variable to keep Express's safe default; every configured value must match
 * the canonical grammar exactly.
 */

export type TrustProxyValue = boolean | number | string[];

const NAMED_SUBNETS: ReadonlySet<string> = new Set(["loopback", "linklocal", "uniquelocal"]);

// Strict positive integer: no leading zeros, no whitespace, no sign.
const STRICT_POS_INT_RE = /^[1-9]\d*$/;
const STRICT_PREFIX_RE = /^(?:0|[1-9]\d*)$/;

function isValidSubnetToken(token: string): boolean {
  if (NAMED_SUBNETS.has(token)) return true;

  const parts = token.split("/");
  if (parts.length > 2) return false;

  const address = parts[0];
  const family = isIP(address);
  if (family === 0) return false;

  const prefix = parts[1];
  if (prefix === undefined) return true;
  if (!STRICT_PREFIX_RE.test(prefix)) return false;

  const maxPrefix = family === 4 ? 32 : 128;
  return Number(prefix) <= maxPrefix;
}

/**
 * Parse a raw env-var value into the form Express's `app.set("trust proxy", …)`
 * accepts, or `undefined` to mean "leave Express at its safe default."
 *
 * Throws `Error` with an explanatory message if the value is malformed.
 */
export function parseTrustProxyEnv(raw: string | undefined): TrustProxyValue | undefined {
  if (raw === undefined) return undefined;
  if (raw.length === 0) {
    throw new Error("TRUST_PROXY: empty values are invalid — omit the variable to disable proxy trust");
  }
  if (/\s/.test(raw)) {
    throw new Error(`TRUST_PROXY: whitespace is not allowed in ${JSON.stringify(raw)}`);
  }
  if (raw === "true") return true;
  if (STRICT_POS_INT_RE.test(raw)) return Number(raw);
  if (/^\d+$/.test(raw)) {
    throw new Error(
      `TRUST_PROXY: invalid integer value ${JSON.stringify(raw)} — use a positive integer with no leading zeros or whitespace`,
    );
  }
  const tokens = raw.split(",");
  if (tokens.some((token) => token.length === 0)) {
    throw new Error(`TRUST_PROXY: empty subnet token in ${JSON.stringify(raw)}`);
  }
  if (new Set(tokens).size !== tokens.length) {
    throw new Error(`TRUST_PROXY: duplicate subnet token in ${JSON.stringify(raw)}`);
  }
  for (const token of tokens) {
    if (!isValidSubnetToken(token)) {
      throw new Error(
        `TRUST_PROXY: unrecognized token ${JSON.stringify(token)} — expected one of {loopback, linklocal, uniquelocal} or a CIDR like 10.0.0.0/8 or fd00::/8`,
      );
    }
  }
  return tokens;
}

/**
 * Apply the parsed value to the given Express app. No-op when the value
 * is `undefined`, preserving Express's default (trust nothing).
 */
export function applyTrustProxy(
  app: { set: (key: string, value: TrustProxyValue) => unknown },
  value: TrustProxyValue | undefined,
): void {
  if (value === undefined) return;
  app.set("trust proxy", value);
}
