import { describe, expect, it } from "vitest";
import { wrapCommandWithEnv } from "../../src/pod-exec.js";

describe("wrapCommandWithEnv", () => {
  it("starts from a clean environment even when there are no explicit values", () => {
    const expected = [
      "/bin/sh",
      "-c",
      "paperclip_provider_home=\"$(mktemp -d /tmp/paperclip-provider-home.XXXXXX)\" && trap 'rm -rf -- \"$paperclip_provider_home\"' EXIT && env -i PATH='/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin' HOME=\"$paperclip_provider_home\" USERPROFILE=\"$paperclip_provider_home\" 'provider-cli' 'run'",
    ];
    expect(wrapCommandWithEnv(["provider-cli", "run"], undefined)).toEqual(expected);
    expect(wrapCommandWithEnv(["provider-cli", "run"], {})).toEqual(expected);
  });

  it("passes only explicit env vars and execs the original command", () => {
    const out = wrapCommandWithEnv(
      ["provider-cli", "run", "--model", "provider/model"],
      { XDG_CONFIG_HOME: "/tmp/cfg", PROVIDER_TOKEN: "provider-secret" },
    );
    expect(out[0]).toBe("/bin/sh");
    expect(out[1]).toBe("-c");
    expect(out[2]).toContain("env -i PATH=");
    expect(out[2]).toContain('HOME="$paperclip_provider_home"');
    expect(out[2]).toContain("XDG_CONFIG_HOME='/tmp/cfg'");
    expect(out[2]).toContain("PROVIDER_TOKEN='provider-secret'");
    expect(out[2]).toContain("'provider-cli' 'run' '--model' 'provider/model'");
  });

  it("uses an explicitly target-scoped PATH", () => {
    const out = wrapCommandWithEnv(["provider-cli"], { PATH: "/server/bin", XDG_CONFIG_HOME: "/c" });
    expect(out[2]).toContain("PATH='/server/bin'");
    expect(out[2]).toContain("XDG_CONFIG_HOME=");
  });

  it("skips invalid identifiers and non-string values", () => {
    const out = wrapCommandWithEnv(["provider-cli"], {
      "BAD-KEY": "x",
      GOOD_KEY: "y",
      // @ts-expect-error intentional non-string to exercise the guard
      NUMERIC: 5,
    });
    expect(out[2]).toContain("GOOD_KEY='y'");
    expect(out[2]).not.toContain("BAD-KEY");
    expect(out[2]).not.toContain("NUMERIC");
  });

  it("shell-escapes single quotes in values", () => {
    const out = wrapCommandWithEnv(["provider-cli"], { V: "a'b" });
    expect(out[2]).toContain("V='a'\\''b'");
  });
});
