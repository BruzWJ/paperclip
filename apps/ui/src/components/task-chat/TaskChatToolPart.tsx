import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { CodeBlockPanel } from "@/components/patterns/CodeBlockPanel";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, Hammer } from "lucide-react";
import { useState } from "react";
import {
  describeToolInput,
  displayToolName,
  formatToolPayload,
  isCommandTool,
  parseToolPayload,
  summarizeToolInput,
  summarizeToolResult,
} from "../../lib/transcriptPresentation";
import { cn } from "../../lib/utils";

export const TOOL_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  // Extend with specific tool icons as they become known
};

export function getToolIcon(toolName: string): React.ComponentType<{ className?: string }> {
  return TOOL_ICON_MAP[toolName] ?? Hammer;
}

export function TaskChatToolPart({
  toolName,
  args,
  argsText,
  result,
}: {
  toolName: string;
  args?: unknown;
  argsText?: string;
  result?: unknown;
}) {
  const [open, setOpen] = useState(false);
  const rawArgsText = argsText ?? "";
  const parsedArgs = args ?? parseToolPayload(rawArgsText);
  const resultText =
    typeof result === "string" ? result : result === undefined ? "" : formatToolPayload(result);
  const inputDetails = describeToolInput(toolName, parsedArgs);
  const displayName = displayToolName(toolName, parsedArgs);
  const isCommand = isCommandTool(toolName, parsedArgs);
  const summary = isCommand
    ? null
    : result === undefined
      ? summarizeToolInput(toolName, parsedArgs)
      : summarizeToolResult(resultText, false);
  const ToolIcon = getToolIcon(toolName);

  const intentDetail = inputDetails.find((d) => d.label === "Intent");
  const title = intentDetail?.value ?? displayName;
  const nonIntentDetails = inputDetails.filter((d) => d.label !== "Intent");

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex gap-2 px-1">
      <div className="flex flex-col items-center pt-1">
        <ToolIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        {open ? <div className="mt-1 w-px flex-1 bg-border/40" /> : null}
      </div>

      <div className="min-w-0 flex-1">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start">
            <span className="min-w-0 flex-1 truncate text-(length:--text-compact) text-muted-foreground/80">
              {title}
              {!intentDetail && summary ? (
                <span className="ml-1.5 text-muted-foreground/50">{summary}</span>
              ) : null}
            </span>
            {result === undefined ? <Spinner className="h-3 w-3 shrink-0 text-muted-foreground/50" /> : null}
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition-transform",
                open && "rotate-180",
              )}
            />
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent className="mt-1 space-y-2 pb-1">
          {nonIntentDetails.length > 0 ? (
            <div>
              <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/60">
                Input
              </div>
              <dl className="space-y-1.5">
                {nonIntentDetails.map((detail) => (
                  <div key={`${detail.label}:${detail.value}`}>
                    <dt className="text-(length:--text-nano) font-medium text-muted-foreground/60">
                      {detail.label}
                    </dt>
                    <dd
                      className={cn(
                        "text-xs leading-5 text-foreground/70",
                        detail.tone === "code" && "font-mono text-(length:--text-micro)",
                      )}
                    >
                      {detail.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : rawArgsText ? (
            <div>
              <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/60">
                Input
              </div>
              <CodeBlockPanel
                bodyClassName="max-h-64"
                code={rawArgsText}
                filename="tool-input.txt"
                syntaxHighlighting={false}
              />
            </div>
          ) : null}
          {result !== undefined ? (
            <div>
              <div className="mb-1 text-(length:--text-nano) font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground/60">
                Result
              </div>
              <CodeBlockPanel
                bodyClassName="max-h-64"
                code={resultText}
                filename="tool-result.txt"
                syntaxHighlighting={false}
              />
            </div>
          ) : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
