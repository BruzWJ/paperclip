import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import {
  DEFAULT_SANDBOX_REMOTE_CWD,
  resolveEnvironmentExecutionTarget,
} from "../services/environment-execution-target.js";

describe("resolveEnvironmentExecutionTarget", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
  });

  it("uses a bounded default cwd for sandbox targets when lease metadata omits remoteCwd", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
      leaseId: "lease-1",
      environmentId: "env-1",
      timeoutMs: 30_000,
    });
  });

  it("keeps sandbox targets on bridge mode even when lease metadata includes a Paperclip API URL", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        paperclipApiUrl: "https://paperclip.example.test",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: DEFAULT_SANDBOX_REMOTE_CWD,
    });
    expect(target).not.toHaveProperty("paperclipApiUrl");
    expect(target).not.toHaveProperty("paperclipTransport");
  });

  it("passes through a provider-declared sandbox shell command from lease metadata", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        shellCommand: "bash",
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      shellCommand: "bash",
    });
  });

  it("keeps sandbox targets on callback bridge execution even when lease metadata advertises SSH access", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: {
          provider: "fake-plugin",
        },
      },
      leaseId: "lease-1",
      leaseMetadata: {
        remoteCwd: "/home/sandbox/paperclip-workspace",
        sshAccess: {
          type: "ssh",
          host: "ssh.example.test",
          port: 22,
          username: "paperclip",
        },
      },
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "sandbox",
      providerKey: "fake-plugin",
      remoteCwd: "/home/sandbox/paperclip-workspace",
    });
  });

  it("forwards the productive attempt identity to execute and exact cancellation", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "fake-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });
    const lease = {
      id: "lease-row-1",
      companyId: "company-1",
      providerLeaseId: "provider-lease-1",
      metadata: {},
    } as never;
    const environmentRuntime = {
      supportsExecutionCancellation: vi.fn(() => true),
      supportsSync: vi.fn(() => false),
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok",
        stderr: "",
      })),
      cancelExecution: vi.fn(async (input: { executionId: string }) => ({
        executionId: input.executionId,
        cancelled: true,
      })),
    };
    const environment = {
      id: "env-1",
      driver: "sandbox",
      config: { provider: "fake-plugin" },
    };

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex",
      environment,
      leaseId: "lease-row-1",
      leaseMetadata: {},
      lease,
      environmentRuntime: environmentRuntime as never,
    });
    if (!target || target.kind !== "remote" || target.transport !== "sandbox" || !target.runner) {
      throw new Error("Expected a runnable sandbox target.");
    }

    await target.runner.execute({
      executionId: "productive-attempt-id",
      command: "agent-cli",
      args: ["--json"],
    });
    await target.runner.cancelExecution?.({
      executionId: "productive-attempt-id",
      reason: "operator cancelled",
    });

    expect(environmentRuntime.execute).toHaveBeenCalledWith(expect.objectContaining({
      environment,
      lease,
      executionId: "productive-attempt-id",
      command: "agent-cli",
      args: ["--json"],
    }));
    expect(environmentRuntime.cancelExecution).toHaveBeenCalledWith({
      companyId: "company-1",
      environment,
      lease,
      executionId: "productive-attempt-id",
      reason: "operator cancelled",
    });
  });

  it("builds a first-class plugin target with execute, cancel, and paired native sync", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "workspace-driver",
        driverConfig: {
          timeoutMs: 45_000,
          shellCommand: "bash",
        },
      },
    });
    const lease = {
      id: "lease-plugin-1",
      companyId: "company-1",
      providerLeaseId: "provider-lease-plugin-1",
      metadata: {
        pluginId: "plugin-installation-1",
      },
    } as never;
    const environment = {
      id: "env-plugin-1",
      driver: "plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "workspace-driver",
        driverConfig: {},
      },
    };
    const environmentRuntime = {
      supportsExecutionCancellation: vi.fn(() => true),
      supportsSync: vi.fn(() => true),
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "plugin output",
        stderr: "",
      })),
      cancelExecution: vi.fn(async (input: { executionId: string }) => ({
        executionId: input.executionId,
        cancelled: true,
      })),
      syncIn: vi.fn(async () => ({ operations: [] })),
      syncOut: vi.fn(async () => ({ operations: [] })),
    };

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex",
      environment,
      leaseId: "lease-plugin-1",
      leaseMetadata: {},
      realizedCwd: "/plugin/workspace",
      lease,
      environmentRuntime: environmentRuntime as never,
    });
    if (
      !target ||
      target.kind !== "remote" ||
      target.transport !== "plugin" ||
      !target.runner
    ) {
      throw new Error("Expected a runnable plugin target.");
    }

    expect(target).toMatchObject({
      pluginKey: "acme.environments",
      driverKey: "workspace-driver",
      remoteCwd: "/plugin/workspace",
      timeoutMs: 45_000,
      shellCommand: "bash",
    });
    await target.runner.execute({
      executionId: "provider-attempt-1",
      command: "provider-cli",
      args: ["--stream"],
    });
    await target.runner.cancelExecution?.({
      executionId: "provider-attempt-1",
      reason: "provider run cancelled",
    });
    await target.runner.syncIn?.([]);
    await target.runner.syncOut?.([]);

    expect(environmentRuntime.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: "provider-attempt-1",
        cwd: "/plugin/workspace",
      }),
    );
    expect(environmentRuntime.cancelExecution).toHaveBeenCalledWith({
      companyId: "company-1",
      environment,
      lease,
      executionId: "provider-attempt-1",
      reason: "provider run cancelled",
    });
    expect(environmentRuntime.syncIn).toHaveBeenCalledOnce();
    expect(environmentRuntime.syncOut).toHaveBeenCalledOnce();
  });

  it(
    "admits plugin targets for the conformance-approved declarative adapter",
    async () => {
      mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
        driver: "plugin",
        config: {
          pluginKey: "acme.environments",
          driverKey: "workspace-driver",
          driverConfig: {},
        },
      });
      const lease = {
        id: "lease-plugin-1",
        companyId: "company-1",
        metadata: { pluginId: "plugin-installation-1" },
      } as never;
      const target = await resolveEnvironmentExecutionTarget({
        db: {} as never,
        companyId: "company-1",
        adapterType: "codex",
        environment: {
          id: "env-plugin-1",
          driver: "plugin",
          config: {},
        },
        leaseId: "lease-plugin-1",
        leaseMetadata: {},
        realizedCwd: "/plugin/workspace",
        lease,
        environmentRuntime: {
          supportsExecutionCancellation: vi.fn(() => true),
          supportsSync: vi.fn(() => false),
          execute: vi.fn(),
          cancelExecution: vi.fn(),
        } as never,
      });

      expect(target).toMatchObject({
        kind: "remote",
        transport: "plugin",
        pluginKey: "acme.environments",
        driverKey: "workspace-driver",
        remoteCwd: "/plugin/workspace",
      });
    },
  );

  it("fails plugin target resolution without an exact realized cwd", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "plugin",
      config: {
        pluginKey: "acme.environments",
        driverKey: "workspace-driver",
        driverConfig: {},
      },
    });

    await expect(
      resolveEnvironmentExecutionTarget({
        db: {} as never,
        companyId: "company-1",
        adapterType: "codex",
        environment: {
          id: "env-plugin-1",
          driver: "plugin",
          config: {},
        },
        leaseId: "lease-plugin-1",
        leaseMetadata: {},
        lease: {} as never,
        environmentRuntime: {
          supportsExecutionCancellation: vi.fn(() => true),
        } as never,
      }),
    ).rejects.toThrow("did not realize an exact workspace cwd");
  });

  it("fails sandbox target readiness when the provider lacks exact cancellation", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "sandbox",
      config: {
        provider: "legacy-plugin",
        reuseLease: false,
        timeoutMs: 30_000,
      },
    });
    const environmentRuntime = {
      supportsExecutionCancellation: vi.fn(() => false),
    };

    await expect(resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex",
      environment: {
        id: "env-1",
        driver: "sandbox",
        config: { provider: "legacy-plugin" },
      },
      leaseId: "lease-row-1",
      leaseMetadata: {},
      lease: {
        id: "lease-row-1",
        companyId: "company-1",
        providerLeaseId: "provider-lease-1",
        metadata: {},
      } as never,
      environmentRuntime: environmentRuntime as never,
    })).rejects.toThrow("does not support exact command cancellation");
  });

  it("resolves SSH execution targets in bridge mode", async () => {
    mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
      driver: "ssh",
      config: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        privateKey: "PRIVATE KEY",
        knownHosts: "[ssh.example.test]:22 ssh-ed25519 AAAA",
        strictHostKeyChecking: true,
      },
    });

    const target = await resolveEnvironmentExecutionTarget({
      db: {} as never,
      companyId: "company-1",
      adapterType: "codex",
      environment: {
        id: "env-ssh-1",
        driver: "ssh",
        config: {},
      },
      leaseId: "lease-ssh-1",
      leaseMetadata: {},
      lease: null,
      environmentRuntime: null,
    });

    expect(target).toMatchObject({
      kind: "remote",
      transport: "ssh",
      remoteCwd: "/srv/paperclip",
      leaseId: "lease-ssh-1",
      environmentId: "env-ssh-1",
      spec: {
        host: "ssh.example.test",
        port: 22,
        username: "paperclip",
        remoteWorkspacePath: "/srv/paperclip",
        remoteCwd: "/srv/paperclip",
      },
    });
    expect(target).not.toHaveProperty("paperclipApiUrl");
  });

  it.each(["ssh", "sandbox", "plugin"])(
    "does not advertise %s execution mechanics for an unapproved adapter",
    async (driver) => {
      const target = await resolveEnvironmentExecutionTarget({
        db: {} as never,
        companyId: "company-1",
        adapterType: "unapproved-adapter",
        environment: {
          id: `env-${driver}`,
          driver,
          config: {},
        },
        leaseId: null,
        leaseMetadata: {},
        lease: null,
        environmentRuntime: null,
      });

      expect(target).toBeNull();
      expect(
        mockResolveEnvironmentDriverConfigForRuntime,
      ).not.toHaveBeenCalled();
    },
  );
});
