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
import { cn } from "@/lib/utils";

export interface CodeBlockPanelProps {
  code: string;
  filename: string;
  language?: BundledLanguage;
  syntaxHighlighting?: boolean;
  className?: CodeBlockProps["className"];
  bodyClassName?: string;
  lineNumbers?: boolean;
}

export function CodeBlockPanel({
  code,
  filename,
  language,
  syntaxHighlighting = language !== undefined,
  className,
  bodyClassName,
  lineNumbers = false,
}: CodeBlockPanelProps) {
  const value = language ?? "text";
  const data = [{ language: value, filename, code }];

  return (
    <CodeBlock className={className} data={data} defaultValue={value}>
      <CodeBlockHeader>
        <CodeBlockFilename value={value}>{filename}</CodeBlockFilename>
        <CodeBlockCopyButton className="ml-auto" aria-label={`Copy ${filename}`} />
      </CodeBlockHeader>
      <CodeBlockBody className={cn("overflow-auto", bodyClassName)}>
        {(item) => (
          <CodeBlockItem key={item.language} lineNumbers={lineNumbers} value={item.language}>
            <CodeBlockContent language={language} syntaxHighlighting={syntaxHighlighting}>
              {item.code}
            </CodeBlockContent>
          </CodeBlockItem>
        )}
      </CodeBlockBody>
    </CodeBlock>
  );
}
