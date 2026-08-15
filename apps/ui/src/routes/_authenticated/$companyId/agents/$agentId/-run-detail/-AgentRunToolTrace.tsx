import {
  Attachment,
  AttachmentInfo,
  Attachments,
  type AttachmentData,
} from "@/components/ai-elements/attachments";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Tool, ToolContent, ToolHeader, ToolInput, type ToolPart } from "@/components/ai-elements/tool";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { TaskSessionMessage } from "@paperclipai/shared";
import { FileTextIcon } from "lucide-react";

type AssistantMessage = Extract<TaskSessionMessage, { type: "assistant" }>;
type AssistantContentPart = AssistantMessage["content"][number];
type AssistantTool = Extract<AssistantContentPart, { type: "tool" }>;

export interface RunFileReference {
  id: string;
  uri: string;
  mime: string;
  name?: string;
  description?: string;
}

function attachmentData(file: RunFileReference): AttachmentData {
  return {
    type: "file",
    id: file.id,
    url: file.uri,
    mediaType: file.mime,
    filename: file.name ?? file.uri,
  };
}

export function RunFileReferences({ files, label }: { files: readonly RunFileReference[]; label: string }) {
  if (files.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={label}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{label}</h4>
      <Attachments variant="list" role="list" className="gap-1">
        {files.map((file) => (
          <Attachment
            key={file.id}
            data={attachmentData(file)}
            role="listitem"
            className="cursor-default py-2 hover:bg-transparent"
            data-reference-uri={file.uri}
          >
            <div className="min-w-0 flex-1">
              <AttachmentInfo showMediaType />
              <code className="block break-all text-muted-foreground text-xs">{file.uri}</code>
              {file.description ? (
                <p className="mt-1 text-muted-foreground text-xs">{file.description}</p>
              ) : null}
            </div>
          </Attachment>
        ))}
      </Attachments>
    </section>
  );
}

function SerializedValue({ value }: { value: unknown }) {
  const isText = typeof value === "string";
  const code = isText ? value : (JSON.stringify(value, null, 2) ?? String(value));
  return <CodeBlock code={code} language={isText ? "log" : "json"} />;
}

function DataSection({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="space-y-2">
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</h4>
      <div className="overflow-hidden rounded-md bg-muted/50">
        <SerializedValue value={value} />
      </div>
    </section>
  );
}

function toolState(state: AssistantTool["state"]): ToolPart["state"] {
  if (state.status === "pending") return "input-streaming";
  if (state.status === "running") return "input-available";
  if (state.status === "completed") return "output-available";
  return "output-error";
}

export function AgentRunToolTrace({ tool, isCurrent }: { tool: AssistantTool; isCurrent: boolean }) {
  const state = tool.state;
  const contentFiles =
    state.status === "pending"
      ? []
      : state.content
          .filter((item) => item.type === "file")
          .map((file, index) => ({
            id: `${tool.id}-content-${index}`,
            uri: file.uri,
            mime: file.mime,
            name: file.name,
          }));
  const attachmentFiles =
    state.status === "completed"
      ? (state.attachments ?? []).map((file, index) => ({
          id: `${tool.id}-attachment-${index}`,
          uri: file.uri,
          mime: file.mime,
          name: file.name,
          description: file.description,
        }))
      : [];
  const textOutputs = state.status === "pending" ? [] : state.content.filter((item) => item.type === "text");
  const hasStructuredOutput = state.status !== "pending" && Object.keys(state.structured).length > 0;
  const hasResult = state.status !== "pending" && "result" in state && state.result !== undefined;
  const outputPaths = state.status === "completed" ? (state.outputPaths ?? []) : [];

  return (
    <Tool
      defaultOpen={isCurrent || state.status === "error"}
      className="min-w-0 overflow-hidden"
      data-current={isCurrent || undefined}
    >
      <ToolHeader
        type="dynamic-tool"
        toolName={tool.name}
        state={toolState(state)}
        className="min-w-0 overflow-hidden"
      />
      <ToolContent>
        {state.status === "pending" ? (
          <div data-tool-pending-input="raw">
            <DataSection title="Parameters" value={state.input} />
          </div>
        ) : (
          <ToolInput input={state.input} />
        )}
        {state.status === "error" ? (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{state.error.message}</AlertDescription>
          </Alert>
        ) : null}
        {hasResult ? <DataSection title="Result" value={state.result} /> : null}
        {hasStructuredOutput ? <DataSection title="Structured output" value={state.structured} /> : null}
        {textOutputs.map((item, index) => (
          <DataSection key={`${tool.id}-text-${index}`} title="Text output" value={item.text} />
        ))}
        <RunFileReferences files={contentFiles} label="Content files" />
        <RunFileReferences files={attachmentFiles} label="Attachments" />
        {outputPaths.length > 0 ? (
          <section className="space-y-2" aria-label="Reported output paths">
            <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Reported output paths
            </h4>
            <ul className="space-y-1 rounded-md border bg-muted/50 p-2">
              {outputPaths.map((path, index) => (
                <li
                  key={`${tool.id}-output-path-${index}`}
                  className="flex min-w-0 items-start gap-2 text-xs"
                >
                  <FileTextIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                  <code className="break-all">{path}</code>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </ToolContent>
    </Tool>
  );
}
