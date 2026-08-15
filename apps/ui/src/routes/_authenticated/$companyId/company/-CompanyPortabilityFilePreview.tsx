import type { ReactNode } from "react";
import type { CompanyPortabilityFileEntry } from "@paperclipai/shared";
import { Package } from "lucide-react";
import { getPortableFileDataUrl, getPortableFileText, isPortableImageFile } from "@/lib/portable-files";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { parseFrontmatter, type FrontmatterData } from "../../../../components/patterns/FileTree";
import { MarkdownBody } from "../-markdown/-MarkdownBody";
import { CodeBlockPanel } from "@/components/patterns/CodeBlockPanel";
import { DataTable, type ColumnDef } from "@/components/patterns/DataTable";
import { ZoomableImage } from "@/components/patterns/ZoomableImage";

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

type FrontmatterRow = {
  field: string;
  value: string | string[];
};

const FRONTMATTER_COLUMNS: ColumnDef<FrontmatterRow>[] = [
  {
    accessorKey: "field",
    header: "Field",
    enableSorting: false,
    cell: ({ row }) => FRONTMATTER_FIELD_LABELS[row.original.field] ?? row.original.field,
  },
  {
    accessorKey: "value",
    header: "Value",
    enableSorting: false,
    cell: ({ row }) =>
      Array.isArray(row.original.value) ? (
        <div className="flex flex-wrap gap-1.5">
          {row.original.value.map((item) => (
            <Badge key={item} variant="outline">
              {item}
            </Badge>
          ))}
        </div>
      ) : (
        <span>{row.original.value}</span>
      ),
  },
];

function FrontmatterCard({ data }: { data: FrontmatterData }) {
  return (
    <Card className="mb-4 gap-0 py-0">
      <CardContent className="p-0">
        <DataTable
          caption="File metadata"
          columns={FRONTMATTER_COLUMNS}
          data={Object.entries(data).map(([field, value]) => ({ field, value }))}
          showHeader={false}
          getCellClassName={(_row, columnId) =>
            columnId === "field" ? "w-min text-muted-foreground" : "whitespace-normal"
          }
        />
      </CardContent>
    </Card>
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
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Package  data-icon="inline-start"/>
          </EmptyMedia>
          <EmptyTitle>Select a file to preview its contents.</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  const textContent = getPortableFileText(content);
  const isMarkdown = selectedFile.endsWith(".md") && textContent !== null;
  const parsed = isMarkdown && textContent ? parseFrontmatter(textContent) : null;
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
        return getPortableFileDataUrl(resolved in allFiles ? resolved : src, entry);
      }
    : undefined;

  return (
    <div className="min-w-0">
      <div className="border-b border-border px-5 py-3">
        {header ?? <div className="truncate font-mono text-sm">{selectedFile}</div>}
      </div>
      <div className="min-h-(--sz-560px) px-5 py-5">
        {parsed ? (
          <>
            <FrontmatterCard data={parsed.data} />
            {parsed.body.trim() && (
              <MarkdownBody resolveImageSrc={resolveImageSrc} softBreaks={false} linkTaskReferences={false}>
                {parsed.body}
              </MarkdownBody>
            )}
          </>
        ) : isMarkdown ? (
          <MarkdownBody resolveImageSrc={resolveImageSrc} softBreaks={false} linkTaskReferences={false}>
            {textContent ?? ""}
          </MarkdownBody>
        ) : imageSrc ? (
          <Card className="min-h-(--sz-520px) items-center justify-center p-6">
            <ZoomableImage
              src={imageSrc}
              alt={selectedFile}
              className="max-h-(--sz-480px) max-w-full object-contain"
            />
          </Card>
        ) : textContent !== null ? (
          <CodeBlockPanel code={textContent} filename={selectedFile} syntaxHighlighting={false} />
        ) : (
          <Alert>
            <AlertDescription>Binary asset preview is not available for this file type.</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
