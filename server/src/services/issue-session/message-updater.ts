import {
  decodeIssueSessionMessage,
  encodeIssueSessionMessage,
  Message,
  type IssueSessionEvent,
  type IssueSessionMessage,
} from "@paperclipai/shared/issue-session";

export interface IssueSessionMessageStore {
  getCurrentAssistant(): Promise<Message.Assistant | undefined>;
  getAssistant(messageId: Message.ID): Promise<Message.Assistant | undefined>;
  getCurrentShell(callId: string): Promise<Message.Shell | undefined>;
  updateAssistant(message: Message.Assistant): Promise<void>;
  updateShell(message: Message.Shell): Promise<void>;
  appendMessage(message: IssueSessionMessage): Promise<void>;
}

function cloneMessage<T extends IssueSessionMessage>(message: T): T {
  return decodeIssueSessionMessage(encodeIssueSessionMessage(message)) as T;
}

async function updateAssistant(
  store: IssueSessionMessageStore,
  messageId: Message.ID,
  mutate: (message: any) => void,
): Promise<void> {
  const current = await store.getAssistant(messageId);
  if (!current) return;
  const next = cloneMessage(current) as any;
  mutate(next);
  await store.updateAssistant(next);
}

function latestTool(message: any, callId: string): any {
  return message.content.findLast(
    (part: any) =>
      part.type === "tool" && part.id === callId,
  );
}

export async function applyIssueSessionMessageEvent(
  store: IssueSessionMessageStore,
  event: IssueSessionEvent,
): Promise<void> {
  switch (event.type) {
    case "session.next.agent.switched":
      await store.appendMessage(
        Message.AgentSwitched.make({
          id: event.data.messageID,
          type: "agent-switched",
          metadata: event.metadata,
          agent: event.data.agent,
          time: { created: event.data.timestamp },
        }),
      );
      return;
    case "session.next.model.switched":
      await store.appendMessage(
        Message.ModelSwitched.make({
          id: event.data.messageID,
          type: "model-switched",
          metadata: event.metadata,
          model: event.data.model,
          time: { created: event.data.timestamp },
        }),
      );
      return;
    case "session.next.prompted":
      await store.appendMessage(
        Message.User.make({
          id: event.data.messageID,
          type: "user",
          metadata: event.metadata,
          text: event.data.prompt.text,
          files: event.data.prompt.files,
          agents: event.data.prompt.agents,
          time: { created: event.data.timestamp },
        }),
      );
      return;
    case "session.next.context.updated":
      await store.appendMessage(
        Message.System.make({
          id: event.data.messageID,
          type: "system",
          text: event.data.text,
          time: { created: event.data.timestamp },
        }),
      );
      return;
    case "session.next.synthetic":
      await store.appendMessage(
        Message.Synthetic.make({
          id: event.data.messageID,
          type: "synthetic",
          sessionID: event.data.sessionID,
          text: event.data.text,
          time: { created: event.data.timestamp },
        }),
      );
      return;
    case "session.next.shell.started":
      await store.appendMessage(
        Message.Shell.make({
          id: event.data.messageID,
          type: "shell",
          metadata: event.metadata,
          callID: event.data.callID,
          command: event.data.command,
          output: "",
          time: { created: event.data.timestamp },
        }),
      );
      return;
    case "session.next.shell.ended": {
      const current = await store.getCurrentShell(event.data.callID);
      if (!current) return;
      const next = cloneMessage(current) as any;
      next.output = event.data.output;
      next.time.completed = event.data.timestamp;
      await store.updateShell(next);
      return;
    }
    case "session.next.step.started": {
      const current = await store.getCurrentAssistant();
      if (current) {
        const settled = cloneMessage(current) as any;
        settled.time.completed = event.data.timestamp;
        await store.updateAssistant(settled);
      }
      await store.appendMessage(
        Message.Assistant.make({
          id: event.data.assistantMessageID,
          type: "assistant",
          agent: event.data.agent,
          model: event.data.model,
          time: { created: event.data.timestamp },
          content: [],
          snapshot: event.data.snapshot
            ? { start: event.data.snapshot }
            : undefined,
        }),
      );
      return;
    }
    case "session.next.step.ended":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        message.time.completed = event.data.timestamp;
        message.finish = event.data.finish;
        if (event.data.cost !== undefined) {
          message.cost = event.data.cost;
        }
        if (event.data.tokens !== undefined) {
          message.tokens = event.data.tokens;
        }
        if (event.data.snapshot || event.data.files) {
          message.snapshot = {
            ...message.snapshot,
            end: event.data.snapshot,
            files: event.data.files ? [...event.data.files] : undefined,
          };
        }
      });
      return;
    case "session.next.step.failed":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        message.time.completed = event.data.timestamp;
        message.finish = "error";
        message.error = event.data.error;
      });
      return;
    case "session.next.text.started":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        message.content.push(
          Message.AssistantText.make({
            type: "text",
            id: event.data.textID,
            text: "",
          }),
        );
      });
      return;
    case "session.next.text.delta":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        const part = message.content.findLast(
          (item: any) =>
            item.type === "text" && item.id === event.data.textID,
        );
        if (part) part.text += event.data.delta;
      });
      return;
    case "session.next.text.ended":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        const part = message.content.findLast(
          (item: any) =>
            item.type === "text" && item.id === event.data.textID,
        );
        if (part) part.text = event.data.text;
      });
      return;
    case "session.next.reasoning.started":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        message.content.push(
          Message.AssistantReasoning.make({
            type: "reasoning",
            id: event.data.reasoningID,
            text: "",
            providerMetadata: event.data.providerMetadata,
            time: { created: event.data.timestamp },
          }),
        );
      });
      return;
    case "session.next.reasoning.delta":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        const part = message.content.findLast(
          (item: any) =>
            item.type === "reasoning" && item.id === event.data.reasoningID,
        );
        if (part) part.text += event.data.delta;
      });
      return;
    case "session.next.reasoning.ended":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        const part = message.content.findLast(
          (item: any) =>
            item.type === "reasoning" && item.id === event.data.reasoningID,
        );
        if (!part) return;
        part.text = event.data.text;
        part.time = {
          created: part.time?.created ?? event.data.timestamp,
          completed: event.data.timestamp,
        };
        if (event.data.providerMetadata !== undefined) {
          part.providerMetadata = event.data.providerMetadata;
        }
      });
      return;
    case "session.next.tool.input.started":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        message.content.push(
          Message.AssistantTool.make({
            type: "tool",
            id: event.data.callID,
            name: event.data.name,
            time: { created: event.data.timestamp },
            state: Message.ToolStatePending.make({
              status: "pending",
              input: "",
            }),
          }),
        );
      });
      return;
    case "session.next.tool.input.ended":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        const tool = latestTool(message, event.data.callID);
        if (tool?.state.status === "pending") tool.state.input = event.data.text;
      });
      return;
    case "session.next.tool.called":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        const tool = latestTool(message, event.data.callID);
        if (!tool) return;
        tool.provider = event.data.provider;
        tool.time.ran = event.data.timestamp;
        tool.state = Message.ToolStateRunning.make({
          status: "running",
          input: event.data.input,
          structured: {},
          content: [],
        });
      });
      return;
    case "session.next.tool.progress":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        const tool = latestTool(message, event.data.callID);
        if (tool?.state.status !== "running") return;
        tool.state.structured = event.data.structured;
        tool.state.content = [...event.data.content];
      });
      return;
    case "session.next.tool.success":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        const tool = latestTool(message, event.data.callID);
        if (tool?.state.status !== "running") return;
        tool.provider = {
          executed:
            event.data.provider.executed ||
            tool.provider?.executed === true,
          metadata: tool.provider?.metadata,
          resultMetadata: event.data.provider.metadata,
        };
        tool.time.completed = event.data.timestamp;
        tool.state = Message.ToolStateCompleted.make({
          status: "completed",
          input: tool.state.input,
          structured: event.data.structured,
          content: [...event.data.content],
          outputPaths: event.data.outputPaths
            ? [...event.data.outputPaths]
            : [],
          result: event.data.result,
        });
      });
      return;
    case "session.next.tool.failed":
      await updateAssistant(store, event.data.assistantMessageID, (message) => {
        const tool = latestTool(message, event.data.callID);
        if (
          !tool ||
          (tool.state.status !== "pending" &&
            tool.state.status !== "running")
        ) {
          return;
        }
        const prior = tool.state;
        tool.provider = {
          executed:
            event.data.provider.executed ||
            tool.provider?.executed === true,
          metadata: tool.provider?.metadata,
          resultMetadata: event.data.provider.metadata,
        };
        tool.time.completed = event.data.timestamp;
        tool.state = Message.ToolStateError.make({
          status: "error",
          error: event.data.error,
          input: typeof prior.input === "string" ? {} : prior.input,
          structured: prior.status === "running" ? prior.structured : {},
          content: prior.status === "running" ? prior.content : [],
          result: event.data.result,
        });
      });
      return;
    case "session.next.moved":
    case "session.next.prompt.admitted":
    case "session.next.tool.input.delta":
    case "session.next.retried":
    case "session.next.revert.staged":
    case "session.next.revert.cleared":
    case "session.next.revert.committed":
      return;
  }
}
