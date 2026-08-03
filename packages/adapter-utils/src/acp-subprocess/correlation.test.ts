import { describe, expect, it } from "vitest";
import {
  ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
  ACP_SESSION_CORRELATION_KIND,
  createAcpSessionCorrelation,
  parseAcpSessionCorrelation,
  readAcpSessionCorrelation,
} from "./correlation.js";

describe("ACP session correlation", () => {
  it("round-trips an opaque exact session id", () => {
    const correlation = createAcpSessionCorrelation("opaque/session id");
    expect(correlation.version).toBe(
      ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
    );
    expect(correlation.kind).toBe(ACP_SESSION_CORRELATION_KIND);
    expect(readAcpSessionCorrelation(correlation)).toBe("opaque/session id");
    expect(parseAcpSessionCorrelation(correlation)).toEqual(correlation);
  });

  it.each(["", null, {}, { value: "legacy" }, { sessionId: "id", extra: true }])(
    "rejects invalid payload %j",
    (payload) => {
      expect(() =>
        readAcpSessionCorrelation({
          version: "issue-execution-native/v1",
          kind: ACP_SESSION_CORRELATION_KIND,
          payload,
        }),
      ).toThrow();
    },
  );

  it("rejects adapter-defined correlation kinds and envelope extensions", () => {
    expect(() =>
      readAcpSessionCorrelation({
        version: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
        kind: "provider-session/v1",
        payload: { sessionId: "opaque" },
      }),
    ).toThrow();
    expect(() =>
      readAcpSessionCorrelation({
        version: ACP_SESSION_CORRELATION_ENVELOPE_VERSION,
        kind: ACP_SESSION_CORRELATION_KIND,
        payload: { sessionId: "opaque" },
        provider: "legacy",
      }),
    ).toThrow();
  });
});
