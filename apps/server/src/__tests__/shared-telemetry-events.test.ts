import { describe, expect, it, vi } from "vitest";
import {
  trackAgentCreated,
  trackAgentTaskCompleted,
  trackInstallCompleted,
} from "@paperclipai/shared/telemetry";
import type { TelemetryClient } from "@paperclipai/shared/telemetry";

function createClient(): TelemetryClient {
  return {
    track: vi.fn(),
    hashPrivateRef: vi.fn((value: string) => `hashed:${value}`),
  } as unknown as TelemetryClient;
}

describe("shared telemetry agent events", () => {
  it("includes agent_id for agent.created", () => {
    const client = createClient();

    trackAgentCreated(client, {
      agentId: "11111111-1111-4111-8111-111111111111",
    });

    expect(client.track).toHaveBeenCalledWith("agent.created", {
      agent_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("includes agent_id for agent.task_completed", () => {
    const client = createClient();

    trackAgentTaskCompleted(client, {
      agentId: "33333333-3333-4333-8333-333333333333",
      adapterType: "codex",
    });

    expect(client.track).toHaveBeenCalledWith("agent.task_completed", {
      agent_id: "33333333-3333-4333-8333-333333333333",
      adapter_type: "codex",
    });
  });

  it("keeps non-agent event dimensions unchanged", () => {
    const client = createClient();

    trackInstallCompleted(client, { adapterType: "codex" });

    expect(client.track).toHaveBeenCalledWith("install.completed", {
      adapter_type: "codex",
    });
    expect(client.track).not.toHaveBeenCalledWith(
      "install.completed",
      expect.objectContaining({ agent_id: expect.any(String) }),
    );
  });

});
