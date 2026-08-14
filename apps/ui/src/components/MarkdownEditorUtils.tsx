import "@mdxeditor/editor/style.css";
import { Component, type ErrorInfo, type ReactNode } from "react";
import type { MentionOption } from "./MarkdownEditorTypes";

export function buildMentionOptionMap(mentions: MentionOption[] | undefined): Map<string, MentionOption> {
  const options = new Map<string, MentionOption>();
  for (const mention of mentions ?? []) {
    if (mention.kind === "agent") options.set(`agent:${mention.agentId}`, mention);
    if (mention.kind === "user") options.set(`user:${mention.userId}`, mention);
    if (mention.kind === "project") options.set(`project:${mention.projectId}`, mention);
  }
  return options;
}

export class MarkdownEditorRichErrorBoundary extends Component<
  { children: ReactNode; onError: (error: unknown) => void },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Markdown rich editor failed; falling back to raw textarea", {
      error,
      componentStack: info.componentStack,
    });
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

export function readHtmlAttribute(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
}

export function convertHtmlImagesToMarkdown(text: string): string {
  return text.replace(/<img\b([^>]*?)\/?>/gi, (tag, attrs: string) => {
    const src = readHtmlAttribute(attrs, "src");
    if (!src) return tag;
    const alt = readHtmlAttribute(attrs, "alt") ?? "image";
    const title = readHtmlAttribute(attrs, "title");
    const escapedAlt = alt.replace(/[[\]]/g, "\\$&");
    const escapedTitle = title?.replace(/"/g, '\\"');
    return escapedTitle ? `![${escapedAlt}](${src} "${escapedTitle}")` : `![${escapedAlt}](${src})`;
  });
}

export function prepareMarkdownForEditor(value: string): string {
  const normalizedLineEndings = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return convertHtmlImagesToMarkdown(normalizedLineEndings);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function hasMeaningfulEditorContent(node: Node | null): boolean {
  if (!node) return false;
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").trim().length > 0;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }

  const element = node as HTMLElement;
  if (["IMG", "HR", "TABLE", "VIDEO", "IFRAME"].includes(element.tagName)) {
    return true;
  }

  return Array.from(element.childNodes).some((child) => hasMeaningfulEditorContent(child));
}

export function hasMarkdownImage(value: string): boolean {
  return /!\[[\s\S]*?\]\([^)]+\)/.test(value);
}

export function isRichEditorDomEmpty(
  editable: HTMLElement,
  expectedValue: string,
  placeholder?: string,
): boolean {
  const expectedText = expectedValue.trim();
  if (!expectedText) return false;
  const expectedHasImage = hasMarkdownImage(expectedText);

  const visibleText = (editable.textContent ?? "").trim();
  if (visibleText.length === 0) {
    if (expectedHasImage) return false;
    return !Array.from(editable.childNodes).some((child) => hasMeaningfulEditorContent(child));
  }

  const normalizedPlaceholder = placeholder?.trim();
  if (
    normalizedPlaceholder &&
    visibleText === normalizedPlaceholder &&
    expectedText !== normalizedPlaceholder
  ) {
    if (expectedHasImage) return false;
    return true;
  }

  return false;
}

export function isSafeMarkdownLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return true;
  return !/^(javascript|data|vbscript):/i.test(trimmed);
}

export function richEditorErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Rich editor failed to render";
}
