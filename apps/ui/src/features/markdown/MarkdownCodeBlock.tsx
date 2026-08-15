import {
  CodeBlock as KiboCodeBlock,
  CodeBlockBody,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockItem,
  type BundledLanguage,
} from "@/components/kibo-ui/code-block";
import { Toggle } from "@/components/ui/toggle";
import { WrapText } from "lucide-react";
import { isValidElement, useMemo, useState, type ReactNode } from "react";
import { bundledLanguages, bundledLanguagesAlias } from "shiki";

import { flattenText, type MarkdownCodeChildProps } from "./MarkdownTransforms";

function extractLanguage(children: ReactNode): string {
  if (!isValidElement(children)) return "text";

  const childProps = children.props as MarkdownCodeChildProps;
  const match =
    typeof childProps.className === "string"
      ? childProps.className.match(/(?:^|\s)language-([^\s]+)/i)
      : null;

  return match?.[1]?.toLowerCase() ?? extractLanguage(childProps.children);
}

function resolveSyntaxLanguage(language: string): BundledLanguage | undefined {
  if (language in bundledLanguages || language in bundledLanguagesAlias) {
    return language as BundledLanguage;
  }
  return undefined;
}

export function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const [wrapLines, setWrapLines] = useState(false);
  const language = extractLanguage(children);
  const syntaxLanguage = resolveSyntaxLanguage(language);
  const code = flattenText(children).replace(/\n$/, "");
  const data = useMemo(() => [{ language, filename: language, code }], [code, language]);
  const wrapLabel = wrapLines ? "Unwrap lines" : "Wrap lines";

  return (
    <KiboCodeBlock
      className="paperclip-markdown-codeblock"
      data={data}
      data-wrap-lines={wrapLines || undefined}
      defaultValue={language}
    >
      <CodeBlockHeader
        className="paperclip-markdown-codeblock-actions justify-end gap-1"
        data-active={wrapLines || undefined}
      >
        <Toggle
          size="sm"
          variant="outline"
          pressed={wrapLines}
          onPressedChange={setWrapLines}
          aria-label={wrapLabel}
          title={wrapLabel}
          className="paperclip-markdown-codeblock-wrap size-8"
        >
          <WrapText aria-hidden="true" className="size-4"  data-icon="inline-start"/>
        </Toggle>
        <CodeBlockCopyButton aria-label="Copy code" title="Copy code" />
      </CodeBlockHeader>
      <CodeBlockBody>
        {(item) => (
          <CodeBlockItem key={item.language} lineNumbers={false} value={item.language}>
            <CodeBlockContent language={syntaxLanguage} syntaxHighlighting={syntaxLanguage !== undefined}>
              {item.code}
            </CodeBlockContent>
          </CodeBlockItem>
        )}
      </CodeBlockBody>
    </KiboCodeBlock>
  );
}
