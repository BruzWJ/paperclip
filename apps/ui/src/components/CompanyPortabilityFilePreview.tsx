import type { ReactNode } from "react";
import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";
import { Package } from "lucide-react";
import {
  getPortableFileDataUrl,
  getPortableFileText,
  isPortableImageFile,
} from "../lib/portable-files";
import { EmptyState } from "./EmptyState";
import { parseFrontmatter } from "./FileTree";
import { MarkdownBody } from "./MarkdownBody";

type FrontmatterData = Record<string, string | string[]>;

const FRONTMATTER_FIELD_LABELS: Record<string, string> = {
  name: "Name",
  title: "Title",
  kind: "Kind",
  reportsTo: "Reports to",
  status: "Status",
  description: "Description",
  priority: "Priority",
  assignee: "Responsible",
  project: "Project",
  recurring: "Recurring",
  targetDate: "Target date",
};

function FrontmatterCard({ data }: { data: FrontmatterData }) {
  return (
    <div className="mb-4 rounded-md border border-border bg-accent/20 px-4 py-3">
      <dl className="grid grid-cols-(--gtc-5) gap-x-4 gap-y-1.5 text-sm">
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="whitespace-nowrap py-0.5 text-muted-foreground">
              {FRONTMATTER_FIELD_LABELS[key] ?? key}
            </dt>
            <dd className="py-0.5">
              {Array.isArray(value) ? (
                <div className="flex flex-wrap gap-1.5">
                  {value.map((item) => (
                    <span
                      key={item}
                      className="inline-flex items-center rounded-md border border-border bg-background px-2 py-0.5 text-xs"
                    >
                      {item}
                    </span>
                  ))}
                </div>
              ) : (
                <span>{value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function CompanyPortabilityFilePreview({
  selectedFile,
  content,
  allFiles,
  header,
}: {
  selectedFile: string | null;
  content: CompanyPortabilityFileEntry | null;
  allFiles: Record<string, CompanyPortabilityFileEntry>;
  header?: ReactNode;
}) {
  if (!selectedFile || content === null) {
    return (
      <EmptyState
        icon={Package}
        message="Select a file to preview its contents."
      />
    );
  }

  const textContent = getPortableFileText(content);
  const isMarkdown = selectedFile.endsWith(".md") && textContent !== null;
  const parsed =
    isMarkdown && textContent ? parseFrontmatter(textContent) : null;
  const imageSrc = isPortableImageFile(selectedFile, content)
    ? getPortableFileDataUrl(selectedFile, content)
    : null;
  const resolveImageSrc = isMarkdown
    ? (src: string) => {
        if (/^(?:https?:|data:)/i.test(src)) return null;
        const dir = selectedFile.includes("/")
          ? selectedFile.slice(0, selectedFile.lastIndexOf("/") + 1)
          : "";
        const resolved = dir + src;
        const entry = allFiles[resolved] ?? allFiles[src];
        if (!entry) return null;
        return getPortableFileDataUrl(
          resolved in allFiles ? resolved : src,
          entry,
        );
      }
    : undefined;

  return (
    <div className="min-w-0">
      <div className="border-b border-border px-5 py-3">
        {header ?? (
          <div className="truncate font-mono text-sm">{selectedFile}</div>
        )}
      </div>
      <div className="min-h-(--sz-560px) px-5 py-5">
        {parsed ? (
          <>
            <FrontmatterCard data={parsed.data} />
            {parsed.body.trim() && (
              <MarkdownBody
                resolveImageSrc={resolveImageSrc}
                softBreaks={false}
                linkTaskReferences={false}
              >
                {parsed.body}
              </MarkdownBody>
            )}
          </>
        ) : isMarkdown ? (
          <MarkdownBody
            resolveImageSrc={resolveImageSrc}
            softBreaks={false}
            linkTaskReferences={false}
          >
            {textContent ?? ""}
          </MarkdownBody>
        ) : imageSrc ? (
          <div className="flex min-h-(--sz-520px) items-center justify-center rounded-lg border border-border bg-accent/10 p-6">
            <img
              src={imageSrc}
              alt={selectedFile}
              className="max-h-(--sz-480px) max-w-full object-contain"
            />
          </div>
        ) : textContent !== null ? (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words border-0 bg-transparent p-0 font-mono text-sm text-foreground">
            <code>{textContent}</code>
          </pre>
        ) : (
          <div className="rounded-lg border border-border bg-accent/10 px-4 py-3 text-sm text-muted-foreground">
            Binary asset preview is not available for this file type.
          </div>
        )}
      </div>
    </div>
  );
}
