import type {
  AgentContextGrantKey,
  AgentMentionReachGrantKey,
  PaperclipActionKey,
} from "@paperclipai/shared";

export type RuntimeAgentConfigurationValues = {
  contextGrants: Record<AgentContextGrantKey, boolean>;
  actionGrants: Record<PaperclipActionKey, boolean>;
  mentionReachGrants: Record<AgentMentionReachGrantKey, boolean>;
};
