import { CodeBlockPanel, type CodeBlockPanelProps } from "./CodeBlockPanel";

function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

export interface JsonCodeBlockProps {
  value: unknown;
  filename?: string;
  className?: CodeBlockPanelProps["className"];
  bodyClassName?: string;
  lineNumbers?: boolean;
}

export function JsonCodeBlock({
  value,
  filename = "data.json",
  className,
  bodyClassName,
  lineNumbers = false,
}: JsonCodeBlockProps) {
  const code = serializeJson(value);
  return (
    <CodeBlockPanel
      bodyClassName={bodyClassName}
      className={className}
      code={code}
      filename={filename}
      language="json"
      lineNumbers={lineNumbers}
    />
  );
}
