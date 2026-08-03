import { describe, it, expect } from "vitest";
import {
  kubernetesProviderConfigSchema,
  parseKubernetesLeaseMetadata,
  parseKubernetesProviderConfig,
} from "../../src/types.js";

const adapters = [
  {
    adapterType: "codex",
    runtimeImage: "registry.example/provider-runtime:v1",
  },
];

describe("kubernetesProviderConfigSchema", () => {
  it("accepts inCluster=true with an explicit Codex runtime", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: true,
      adapters,
      reuseLease: true,
      timeoutMs: 600_000,
    });
    expect(parsed.inCluster).toBe(true);
    expect(parsed.namespacePrefix).toBe("paperclip-");
    expect(parsed.imageAllowList).toEqual([]);
    expect(parsed.egressMode).toBe("standard");
    expect(parsed.adapterType).toBe("codex");
    expect(parsed.reuseLease).toBe(true);
    expect(parsed.timeoutMs).toBe(600_000);
  });

  it("accepts inline kubeconfig", () => {
    const parsed = parseKubernetesProviderConfig({
      inCluster: false,
      kubeconfig: "apiVersion: v1\nkind: Config\n",
      adapters,
    });
    expect(parsed.kubeconfig).toContain("apiVersion");
  });

  it("rejects when neither inCluster nor any kubeconfig source is set", () => {
    expect(() => parseKubernetesProviderConfig({
      inCluster: false,
      adapters,
    })).toThrow(
      /requires one of `inCluster` or `kubeconfig`/,
    );
  });

  it("rejects invalid companySlug", () => {
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        adapters,
        companySlug: "INVALID UPPER",
      }),
    ).toThrow();
  });

  it("rejects egressAllowCidrs entries that are not valid CIDR", () => {
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        adapters,
        egressAllowCidrs: ["not-a-cidr"],
      }),
    ).toThrow(/CIDR/i);
  });

  it("rejects missing runtime registry and a default type without an enabled entry", () => {
    expect(() =>
      parseKubernetesProviderConfig({ inCluster: true })
    ).toThrow();
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        adapterType: "codex",
        adapters: [
          {
            adapterType: "external-provider",
            runtimeImage: "registry.example/external:v1",
          },
        ],
      })
    ).toThrow(/enabled runtime for adapterType/);
  });

  it("rejects ambiguous or normalized runtime identifiers", () => {
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        adapterType: " codex ",
        adapters,
      })
    ).toThrow(/exact non-blank identifier/);
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        adapters: [
          ...adapters,
          {
            adapterType: "codex",
            runtimeImage: "registry.example/other-runtime:v1",
          },
        ],
      })
    ).toThrow(/each exact adapterType once/);
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        adapters: [
          {
            adapterType: "codex",
            runtimeImage: " registry.example/provider-runtime:v1 ",
          },
        ],
      })
    ).toThrow(/leading or trailing whitespace/);
  });

  it("rejects removed backend configuration instead of selecting a compatibility path", () => {
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        adapters,
        backend: "job",
      })
    ).toThrow(/Unrecognized key.*backend/);
    expect(() =>
      parseKubernetesProviderConfig({
        inCluster: true,
        adapters,
        backend: "sandbox-cr",
      })
    ).toThrow(/Unrecognized key.*backend/);
  });
});

describe("kubernetes lease metadata", () => {
  it("accepts only the exact Sandbox CR identity", () => {
    expect(
      parseKubernetesLeaseMetadata({
        namespace: "paperclip-acme",
        sandboxName: "pc-abc",
        podName: "pc-abc",
        phase: "Running",
        pluginId: "server-owned-plugin-id",
        agentId: "server-owned-agent-id",
      }),
    ).toEqual({
      namespace: "paperclip-acme",
      sandboxName: "pc-abc",
      podName: "pc-abc",
      phase: "Running",
    });
  });

  it("requires the canonical Sandbox name", () => {
    expect(() =>
      parseKubernetesLeaseMetadata({
        namespace: "paperclip-acme",
        jobName: "pc-abc",
        podName: "pc-abc",
        phase: "Running",
      })
    ).toThrow();
  });
});
