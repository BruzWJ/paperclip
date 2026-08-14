import { copyTextToClipboard } from "@/lib/clipboard";
import { Check, Copy, WrapText } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";

import { flattenText, mergeScrollableBlockStyle } from "./MarkdownTransforms";

export function CodeBlock({
  children,
  preProps,
}: {
  children: ReactNode;
  preProps: React.HTMLAttributes<HTMLPreElement>;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const [wrapLines, setWrapLines] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleCopy = useCallback(async () => {
    const text = preRef.current?.innerText ?? flattenText(children);
    try {
      await copyTextToClipboard(text);
      setFailed(false);
      setCopied(true);
    } catch {
      setFailed(true);
      setCopied(true);
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1500);
  }, [children]);

  const copyLabel = failed ? "Copy failed" : copied ? "Copied!" : "Copy";
  const wrapLabel = wrapLines ? "Unwrap lines" : "Wrap lines";

  return (
    <div className="paperclip-markdown-codeblock" data-wrap-lines={wrapLines || undefined}>
      <pre
        {...preProps}
        ref={preRef}
        style={{
          ...mergeScrollableBlockStyle(preProps.style as React.CSSProperties | undefined),
          ...(wrapLines
            ? {
                overflowX: "hidden",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
              }
            : null),
        }}
      >
        {children}
      </pre>
      <div
        className="paperclip-markdown-codeblock-actions absolute right-2 top-2 flex gap-1"
        data-active={copied || failed || wrapLines || undefined}
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
          <WrapText aria-hidden="true" className="h-3.5 w-3.5" />
        </Toggle>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleCopy}
          aria-label="Copy code"
          title={copyLabel}
          data-copied={copied || undefined}
          data-failed={failed || undefined}
        >
          {copied && !failed ? (
            <Check aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {copyLabel}
        </Button>
      </div>
    </div>
  );
}
