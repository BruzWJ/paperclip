import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";

import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type DraftInputProps = {
  value: string;
  onCommit: (value: string) => void;
  immediate?: boolean;
  className?: string;
} & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "className"
>;

/** Text input with local draft state that commits on blur. */
export function DraftInput({
  value,
  onCommit,
  immediate,
  className,
  ...props
}: DraftInputProps) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value]);

  return (
    <Input
      aria-label="Configuration value"
      className={className}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        if (immediate) onCommit(event.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      {...props}
    />
  );
}

/** Auto-expanding textarea with local draft state that commits on blur. */
export function DraftTextarea({
  value,
  onCommit,
  immediate,
  placeholder,
  minRows,
}: {
  value: string;
  onCommit: (value: string) => void;
  immediate?: boolean;
  placeholder?: string;
  minRows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rows = minRows ?? 3;
  const lineHeight = 20;
  const minHeight = rows * lineHeight;

  useEffect(() => setDraft(value), [value]);

  const adjustHeight = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(minHeight, element.scrollHeight)}px`;
  }, [minHeight]);

  useEffect(() => {
    adjustHeight();
  }, [adjustHeight, draft]);

  return (
    <Textarea
      ref={textareaRef}
      aria-label="Configuration text"
      className="overflow-hidden font-mono resize-none"
      placeholder={placeholder}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        if (immediate) onCommit(event.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      style={{ minHeight }}
    />
  );
}
