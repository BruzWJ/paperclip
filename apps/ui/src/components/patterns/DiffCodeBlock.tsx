import { useMemo } from "react";

import {
  CodeBlock,
  CodeBlockBody,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockItem,
  type BundledLanguage,
  type CodeBlockProps,
} from "@/components/kibo-ui/code-block";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { cn } from "@/lib/utils";

type DiffLine = {
  kind: "context" | "removed" | "added";
  text: string;
};

function linesOf(text: string) {
  return text.length === 0 ? [] : text.split("\n");
}

function buildDiffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  const commonLengths = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      commonLengths[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? commonLengths[oldIndex + 1][newIndex + 1] + 1
          : Math.max(commonLengths[oldIndex + 1][newIndex], commonLengths[oldIndex][newIndex + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      lines.push({ kind: "context", text: oldLines[oldIndex] });
      oldIndex += 1;
      newIndex += 1;
    } else if (commonLengths[oldIndex + 1][newIndex] >= commonLengths[oldIndex][newIndex + 1]) {
      lines.push({ kind: "removed", text: oldLines[oldIndex] });
      oldIndex += 1;
    } else {
      lines.push({ kind: "added", text: newLines[newIndex] });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    lines.push({ kind: "removed", text: oldLines[oldIndex] });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    lines.push({ kind: "added", text: newLines[newIndex] });
    newIndex += 1;
  }

  return lines;
}

function displayLine(line: DiffLine) {
  const prefix = line.kind === "removed" ? "- " : line.kind === "added" ? "+ " : "  ";
  return `${prefix}${line.text}`;
}

function buildCode(lines: DiffLine[]) {
  const displayCode = lines.map(displayLine).join("\n");
  const annotatedCode = lines
    .flatMap((line) => {
      const rendered = displayLine(line);
      if (line.kind === "context") return [rendered];
      return [`// [!code ${line.kind === "added" ? "++" : "--"}]`, rendered];
    })
    .join("\n");
  return { annotatedCode, displayCode };
}

export interface DiffCodeBlockProps {
  oldText: string;
  newText: string;
  filename?: string;
  language?: BundledLanguage;
  emptyMessage?: string;
  identicalMessage?: string;
  className?: CodeBlockProps["className"];
  bodyClassName?: string;
}

/** A domain-neutral diff adapter over Kibo's notation-aware CodeBlock. */
export function DiffCodeBlock({
  oldText,
  newText,
  filename = "changes.diff",
  language = "diff",
  emptyMessage = "No content on either revision.",
  identicalMessage = "The revisions are identical.",
  className,
  bodyClassName,
}: DiffCodeBlockProps) {
  const lines = useMemo(() => buildDiffLines(oldText, newText), [newText, oldText]);
  const { annotatedCode, displayCode } = useMemo(() => buildCode(lines), [lines]);

  if (oldText.length === 0 && newText.length === 0) {
    return (
      <Empty className="py-8">
        <EmptyDescription>{emptyMessage}</EmptyDescription>
      </Empty>
    );
  }

  if (oldText === newText) {
    return (
      <Empty className="py-8">
        <EmptyDescription>{identicalMessage}</EmptyDescription>
      </Empty>
    );
  }

  const value = language;
  const data = [{ language: value, filename, code: displayCode }];

  return (
    <CodeBlock
      aria-label={`Diff for ${filename}`}
      className={className}
      data={data}
      data-slot="diff-code-block"
      defaultValue={value}
    >
      <CodeBlockHeader>
        <CodeBlockFilename value={value}>{filename}</CodeBlockFilename>
        <CodeBlockCopyButton className="ml-auto" aria-label={`Copy ${filename} diff`} />
      </CodeBlockHeader>
      <CodeBlockBody className={cn("overflow-auto", bodyClassName)}>
        {(item) => (
          <CodeBlockItem key={item.language} lineNumbers={false} value={item.language}>
            <CodeBlockContent language={language}>{annotatedCode}</CodeBlockContent>
          </CodeBlockItem>
        )}
      </CodeBlockBody>
    </CodeBlock>
  );
}
