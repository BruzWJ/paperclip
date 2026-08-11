import { describe, expect, it } from "vitest";
import {
  adapterImplementationIdentityKey,
  isAdapterImplementationIdentity,
  sameAdapterImplementationIdentity,
  type AdapterImplementationIdentity,
} from "./adapter-implementation.js";

const identity: AdapterImplementationIdentity = {
  adapterType: "codex",
  definitionVersion: "acpx-runtime/v1",
  protocolVersion: 1,
  packageName: "@paperclipai/server",
  packageVersion: "0.3.1",
  buildIdentity: "@paperclipai/server@0.3.1:codex",
  artifactDigest: "a".repeat(64),
};

describe("adapter implementation identity", () => {
  it("uses every immutable implementation coordinate in canonical identity", () => {
    const replacement = {
      ...identity,
      artifactDigest: "b".repeat(64),
    };
    expect(isAdapterImplementationIdentity(identity)).toBe(true);
    expect(adapterImplementationIdentityKey(identity)).not.toBe(
      adapterImplementationIdentityKey(replacement),
    );
    expect(sameAdapterImplementationIdentity(identity, replacement)).toBe(
      false,
    );
  });

  it("rejects malformed, versionless, or extensible identities", () => {
    expect(
      isAdapterImplementationIdentity({
        ...identity,
        packageVersion: "",
      }),
    ).toBe(false);
    expect(
      isAdapterImplementationIdentity({
        ...identity,
        artifactDigest: "not-a-digest",
      }),
    ).toBe(false);
    expect(
      isAdapterImplementationIdentity({
        ...identity,
        mutableAlias: "current",
      }),
    ).toBe(false);
  });
});
