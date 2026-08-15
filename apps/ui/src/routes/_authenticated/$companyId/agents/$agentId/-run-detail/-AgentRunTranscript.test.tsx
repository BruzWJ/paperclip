// @vitest-environment jsdom

import type { TaskExecutionSessionMessageRecord } from "@/api/runs";
import {
  createCanonicalSessionRecord,
  createRunEnvelope,
  createTranscriptRecords,
} from "@/test-utils/agent-run-detail";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunTranscript } from "./-AgentRunTranscript";

vi.mock("streamdown", () => ({
  Streamdown: ({ children, isAnimating }: { children: ReactNode; isAnimating?: boolean }) => (
    <div data-testid="streamdown" data-streaming={isAnimating || undefined}>
      {children}
    </div>
  ),
}));

vi.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language: string }) => (
    <pre data-language={language}>{code}</pre>
  ),
}));

vi.mock("use-stick-to-bottom", () => {
  const StickToBottom = ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>;
  StickToBottom.Content = ({ children, ...props }: ComponentProps<"div">) => <div {...props}>{children}</div>;
  return {
    StickToBottom,
    useStickToBottomContext: () => ({ isAtBottom: true, scrollToBottom: vi.fn() }),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("AgentRunTranscript canonical messages", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    window.scrollTo = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("keeps sequence while rendering user, assistant trace, shell, and malformed fallback", async () => {
    const [user, assistant, shell] = createTranscriptRecords();
    const malformed: TaskExecutionSessionMessageRecord = {
      id: "msg_run_malformed",
      seq: 4,
      modelStateSeq: 4,
      type: "assistant",
      data: { unexpected: "future provider payload" },
      timeCreated: "2026-08-14T17:00:20.000Z",
      timeUpdated: "2026-08-14T17:00:20.000Z",
    };

    await act(async () => {
      root.render(
        <AgentRunTranscript
          run={createRunEnvelope()}
          records={[malformed, shell!, assistant!, user!]}
          truncated={false}
          hasMore={false}
          isLoadingMore={false}
          loadMoreError={null}
        />,
      );
    });
    await flush();

    const turns = Array.from(container.querySelectorAll("[data-message-role]"));
    expect(turns.map((turn) => turn.getAttribute("data-message-role"))).toEqual([
      "user",
      "assistant",
      "assistant",
      "system",
    ]);
    expect(turns.map((turn) => turn.textContent?.match(/seq \d/)?.[0])).toEqual([
      "seq 1",
      "seq 2",
      "seq 3",
      "seq 4",
    ]);
    expect(turns[0]?.textContent).toContain("Inspect the run-detail surface");
    expect(turns[1]?.textContent).toContain("The run detail is verified");
    expect(turns[2]?.textContent).toContain("pnpm --filter @paperclipai/ui typecheck");
    expect(turns[2]?.textContent).toContain("Typecheck passed for the UI package");
    expect(turns[3]?.textContent).toContain("Unrecognized session message");
    expect(turns[3]?.querySelector('[data-language="json"]')?.textContent).toContain(
      "future provider payload",
    );

    const executionTrace = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Execution trace · 2 steps"),
    );
    expect(executionTrace).toBeTruthy();
    await act(async () => executionTrace?.click());

    const reasoning = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Thought for a few seconds"),
    );
    expect(reasoning).toBeTruthy();
    await act(async () => reasoning?.click());
    expect(container.textContent).toContain("inspect the contract before presenting the execution trace");

    const tool = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("read_file"),
    );
    expect(tool?.textContent).toContain("Completed");
    await act(async () => tool?.click());
    expect(container.textContent).toContain("AgentRunsPanel.tsx");
    expect(container.textContent).toContain("Read the run-detail panel.");
    expect(container.textContent).toContain('"lines": 182');
    expect(container.textContent).toContain("verified");
    expect(container.textContent).toContain("logs/read-file.log");
    expect(container.textContent).toContain("text/plain");
    expect(container.textContent).toContain("reports/verification.json");
    expect(container.textContent).toContain("application/json");
    expect(container.textContent).toContain("reports/run-detail-summary.md");
    expect(container.textContent).not.toContain("application/octet-stream");
  });

  it("renders synthetic input truthfully and keeps pending tool input raw", async () => {
    const synthetic = createCanonicalSessionRecord({
      seq: 1,
      wire: {
        id: "msg_run_synthetic",
        type: "synthetic",
        sessionID: "ses_run_detail_fixture",
        text: "Continue from the durable provider session.",
        time: { created: Date.parse("2026-08-14T17:00:01.000Z") },
      },
    });
    const rawInput = '{"path":"src/AgentRunTranscript.tsx"';
    const pendingTool = createCanonicalSessionRecord({
      seq: 2,
      wire: {
        id: "msg_run_pending_tool",
        type: "assistant",
        agent: "current-agent",
        content: [
          {
            type: "tool",
            id: "tool-run-pending",
            name: "read_file",
            state: { status: "pending", input: rawInput },
            time: { created: Date.parse("2026-08-14T17:00:02.000Z") },
          },
        ],
        time: { created: Date.parse("2026-08-14T17:00:02.000Z") },
      },
    });

    await act(async () => {
      root.render(
        <AgentRunTranscript
          run={createRunEnvelope({
            status: "running",
            finishedAt: null,
            terminalClassification: null,
            terminalFinalizationId: null,
          })}
          records={[synthetic, pendingTool]}
          truncated={false}
          hasMore={false}
          isLoadingMore={false}
          loadMoreError={null}
        />,
      );
    });
    await flush();

    expect(container.textContent).toContain("Synthetic input");
    expect(container.textContent).not.toContain("Steering input");
    const pendingInput = container.querySelector('[data-tool-pending-input="raw"] pre');
    expect(pendingInput?.textContent).toBe(rawInput);
    expect(pendingInput?.getAttribute("data-language")).toBe("log");
    expect(container.querySelector('[data-current="true"]')?.textContent).toContain("read_file");
  });
});
