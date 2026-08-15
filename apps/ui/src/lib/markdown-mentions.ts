import type { UserMentionReference } from "@/lib/mention-chips";
import type { NamedEntity } from "@/lib/presentation-contracts";

export type MentionOption =
  | (NamedEntity & {
      kind: "agent";
      agentId: string;
      agentIcon?: string | null;
    })
  | (NamedEntity & {
      kind: "project";
      projectId: string;
      projectColor?: string | null;
    })
  | (NamedEntity & UserMentionReference)
  | (NamedEntity & {
      kind: "task";
      taskId: string;
      taskIdentifier: string;
    });
