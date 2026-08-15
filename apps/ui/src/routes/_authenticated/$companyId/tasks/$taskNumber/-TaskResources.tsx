import {
  isSystemTaskDocumentKey,
  type Task,
  type TaskAttachment,
  type TaskWorkProduct,
} from "@paperclipai/shared";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import {
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  ListTree,
  Maximize2,
  PackageOpen,
  Paperclip,
  Plus,
  Trash2,
  Upload,
  type LucideIcon,
} from "lucide-react";

import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";
import { DomainStatus } from "@/components/patterns/DomainStatus";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskLinkQuicklook } from "@/routes/_authenticated/$companyId/-TaskLinkQuicklook";
import { titleizeFilename } from "@/lib/document-file-names";
import {
  attachmentDownloadPath,
  attachmentFilename,
  attachmentOpenPath,
  isImageAttachment,
  isVideoAttachment,
} from "@/lib/task-attachments";
import { taskDisplayTitle } from "@/lib/task-display";
import {
  formatBytes,
  getOutputFileGlyph,
  getTaskOutputs,
  isImageContentType,
  isVideoLikeOutput,
  outputFilename,
  type TaskOutputItem,
} from "@/lib/task-output";
import { cn, relativeTime } from "@/lib/utils";
import { compareTaskDocuments } from "./-task-documents/-TaskDocumentUtils";

const COMPACT_RESOURCE_LIMIT = 6;

export interface TaskResourcesProps {
  task: Task;
  childTasks: Task[];
  childTasksLoading: boolean;
  liveTaskIds: ReadonlySet<string>;
  mutedChildTaskIds: ReadonlySet<string>;
  childPauseBadgeById: ReadonlyMap<string, string>;
  taskLinkState?: ComponentProps<typeof TaskLinkQuicklook>["state"];
  onAddSubTask: () => void;
  attachments: TaskAttachment[];
  attachmentsLoading: boolean;
  attachmentError: string | null;
  attachmentUploadPending: boolean;
  onUploadFiles: (files: File[]) => void | Promise<void>;
  attachmentDeletePending: boolean;
  onDeleteAttachment: (attachmentId: string) => void;
  onPreviewAttachment: (attachment: TaskAttachment) => void;
  workProducts?: TaskWorkProduct[];
  onPreviewOutput: (item: TaskOutputItem) => void;
  onOpenDocuments: () => void;
}

function ResourceSection({
  title,
  count,
  icon: Icon,
  action,
  children,
}: {
  title: string;
  count: number;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2" aria-label={title}>
      <header className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="secondary">{count}</Badge>
        {action ? <div className="ml-auto flex shrink-0 items-center gap-1">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

function CompactResourceList<T extends { id: string }>({
  items,
  emptyMessage,
  renderItem,
}: {
  items: T[];
  emptyMessage: string;
  renderItem: (item: T) => ReactNode;
}) {
  const listKey = items.map((item) => item.id).join("|");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const expanded = expandedKey === listKey;
  const visibleItems = expanded ? items : items.slice(0, COMPACT_RESOURCE_LIMIT);
  const hiddenCount = items.length - visibleItems.length;

  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="space-y-1">
      <ItemGroup className="gap-1">{visibleItems.map(renderItem)}</ItemGroup>
      {items.length > COMPACT_RESOURCE_LIMIT ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="w-full text-muted-foreground"
          onClick={() => setExpandedKey(expanded ? null : listKey)}
        >
          {expanded ? "Show less" : `Show ${hiddenCount} more`}
        </Button>
      ) : null}
    </div>
  );
}

function ResourceLoadingRows({ label }: { label: string }) {
  return (
    <div className="space-y-2" aria-busy="true">
      <span className="sr-only" role="status">
        Loading {label}.
      </span>
      <Skeleton className="h-12 w-full rounded-md" />
      <Skeleton className="h-12 w-full rounded-md" />
    </div>
  );
}

interface ResourceFileRowProps {
  id: string;
  filename: string;
  glyph: string;
  description: ReactNode;
  openPath?: string;
  downloadPath?: string;
  onPreview?: () => void;
  onDelete?: () => void;
  deletePending?: boolean;
}

function ResourceFileRow({
  id,
  filename,
  glyph,
  description,
  openPath,
  downloadPath,
  onPreview,
  onDelete,
  deletePending = false,
}: ResourceFileRowProps) {
  return (
    <Item id={id} size="sm" className="px-2 py-2">
      <ItemMedia>
        <Badge
          variant="secondary"
          className="size-8 shrink-0 justify-center rounded-md border-0 p-0 text-(length:--text-nano) tabular-nums"
          aria-hidden="true"
        >
          {glyph}
        </Badge>
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full min-w-0">
          {openPath ? (
            <a
              href={openPath}
              target="_blank"
              rel="noreferrer"
              className="truncate hover:underline"
              title={filename}
            >
              {filename}
            </a>
          ) : (
            <span className="truncate" title={filename}>
              {filename}
            </span>
          )}
        </ItemTitle>
        <ItemDescription className="text-(length:--text-micro)">{description}</ItemDescription>
      </ItemContent>
      {onPreview || downloadPath || onDelete ? (
        <ItemActions className="gap-0.5">
          {onPreview ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Browse ${filename}`}
              title="Browse"
              onClick={onPreview}
            >
              <Maximize2 data-icon="inline-start" />
            </Button>
          ) : null}
          {downloadPath ? (
            <Button asChild variant="ghost" size="icon-xs">
              <a href={downloadPath} aria-label={`Download ${filename}`} title="Download">
                <Download data-icon="inline-start" />
              </a>
            </Button>
          ) : null}
          {onDelete ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-destructive"
              aria-label={`Delete ${filename}`}
              title="Delete attachment"
              disabled={deletePending}
              onClick={onDelete}
            >
              <Trash2 data-icon="inline-start" />
            </Button>
          ) : null}
        </ItemActions>
      ) : null}
    </Item>
  );
}

export function TaskResources({
  task,
  childTasks,
  childTasksLoading,
  liveTaskIds,
  mutedChildTaskIds,
  childPauseBadgeById,
  taskLinkState,
  onAddSubTask,
  attachments,
  attachmentsLoading,
  attachmentError,
  attachmentUploadPending,
  onUploadFiles,
  attachmentDeletePending,
  onDeleteAttachment,
  onPreviewAttachment,
  workProducts,
  onPreviewOutput,
  onOpenDocuments,
}: TaskResourcesProps) {
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [confirmDeleteAttachment, setConfirmDeleteAttachment] = useState<TaskAttachment | null>(null);
  const subTasks = childTasks.filter((child) => child.parentId === task.id);
  const outputs = getTaskOutputs(workProducts).items;
  const documents = (task.documentSummaries ?? [])
    .filter((document) => !isSystemTaskDocumentKey(document.key))
    .sort(compareTaskDocuments);

  return (
    <div className="space-y-6">
      <ResourceSection
        title="Sub-tasks"
        count={subTasks.length}
        icon={ListTree}
        action={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Create sub-task"
            title="Create sub-task"
            onClick={onAddSubTask}
          >
            <Plus data-icon="inline-start" />
          </Button>
        }
      >
        {childTasksLoading ? (
          <ResourceLoadingRows label="sub-tasks" />
        ) : (
          <CompactResourceList
            items={subTasks}
            emptyMessage="No sub-tasks yet."
            renderItem={(child) => (
              <Item
                key={child.id}
                asChild
                size="sm"
                className={cn("px-2 py-2", mutedChildTaskIds.has(child.id) && "opacity-60")}
              >
                <TaskLinkQuicklook
                  taskId={child.id}
                  taskNumber={child.taskNumber}
                  taskPrefetch={child}
                  state={taskLinkState}
                  title={taskDisplayTitle(child)}
                >
                  <ItemContent className="min-w-0">
                    <ItemTitle className="w-full min-w-0">
                      <span className="truncate">{taskDisplayTitle(child)}</span>
                    </ItemTitle>
                    <ItemDescription className="flex flex-wrap items-center gap-1.5 text-(length:--text-micro)">
                      <span className="font-mono">{child.identifier}</span>
                      <DomainStatus status={child.boardPresentationStatus} />
                      {liveTaskIds.has(child.id) ? <Badge variant="secondary">Live</Badge> : null}
                      {childPauseBadgeById.has(child.id) ? (
                        <Badge variant="outline">{childPauseBadgeById.get(child.id)}</Badge>
                      ) : null}
                    </ItemDescription>
                  </ItemContent>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </TaskLinkQuicklook>
              </Item>
            )}
          />
        )}
      </ResourceSection>

      <ResourceSection
        title="Attachments"
        count={attachments.length}
        icon={Paperclip}
        action={
          <>
            <input
              ref={uploadInputRef}
              className="sr-only"
              type="file"
              multiple
              tabIndex={-1}
              aria-label="Upload task files"
              disabled={attachmentUploadPending}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                if (files.length > 0) void onUploadFiles(files);
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Upload task files"
              title="Upload task files"
              disabled={attachmentUploadPending}
              onClick={() => uploadInputRef.current?.click()}
            >
              <Upload data-icon="inline-start" />
            </Button>
          </>
        }
      >
        {attachmentUploadPending ? (
          <span className="sr-only" role="status">
            Uploading task files.
          </span>
        ) : null}
        {attachmentError ? <p className="text-xs text-destructive">{attachmentError}</p> : null}
        {attachmentsLoading ? (
          <ResourceLoadingRows label="attachments" />
        ) : (
          <CompactResourceList
            items={attachments}
            emptyMessage="No attachments yet. Add files here or from a comment."
            renderItem={(attachment) => {
              const filename = attachmentFilename(attachment);
              const canPreview = isImageAttachment(attachment) || isVideoAttachment(attachment);
              return (
                <ResourceFileRow
                  key={attachment.id}
                  id={`attachment-${attachment.id}`}
                  filename={filename}
                  glyph={getOutputFileGlyph(attachment.contentType).label}
                  description={`${formatBytes(attachment.byteSize)} · ${attachment.contentType}`}
                  openPath={attachmentOpenPath(attachment)}
                  downloadPath={attachmentDownloadPath(attachment)}
                  onPreview={canPreview ? () => onPreviewAttachment(attachment) : undefined}
                  onDelete={() => setConfirmDeleteAttachment(attachment)}
                  deletePending={attachmentDeletePending}
                />
              );
            }}
          />
        )}
      </ResourceSection>

      <ResourceSection title="Outputs" count={outputs.length} icon={PackageOpen}>
        <CompactResourceList
          items={outputs}
          emptyMessage="No durable outputs have been reported."
          renderItem={(item) => {
            const filename = outputFilename(item);
            const metadata = item.metadata;
            const canPreview = Boolean(
              metadata &&
              (isImageContentType(metadata.contentType) ||
                isVideoLikeOutput(metadata.contentType, metadata.originalFilename)),
            );
            return (
              <ResourceFileRow
                key={item.id}
                id={`work-product-${item.id}`}
                filename={filename}
                glyph={getOutputFileGlyph(metadata?.contentType).label}
                description={
                  item.degraded
                    ? "File details unavailable"
                    : `${metadata ? formatBytes(metadata.byteSize) : "Output"} · ${relativeTime(item.createdAt)}`
                }
                openPath={metadata?.openPath}
                downloadPath={metadata?.downloadPath}
                onPreview={canPreview ? () => onPreviewOutput(item) : undefined}
              />
            );
          }}
        />
      </ResourceSection>

      <ResourceSection
        title="Documents"
        count={documents.length}
        icon={FileText}
        action={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Open document workspace"
            title="Open document workspace"
            onClick={onOpenDocuments}
          >
            <ExternalLink data-icon="inline-start" />
          </Button>
        }
      >
        <CompactResourceList
          items={documents}
          emptyMessage="No task documents yet."
          renderItem={(document) => (
            <Item key={document.id} asChild size="sm" className="px-2 py-2">
                <button type="button" className="w-full text-left" onClick={onOpenDocuments}>
                  <ItemMedia>
                    <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="w-full min-w-0">
                      <span className="truncate">
                        {document.title?.trim() || titleizeFilename(document.key)}
                      </span>
                      {document.lockedAt ? <Badge variant="secondary">Locked</Badge> : null}
                    </ItemTitle>
                    <ItemDescription className="text-(length:--text-micro)">
                      {document.key} · revision {document.latestRevisionNumber} ·{" "}
                      {relativeTime(document.updatedAt)}
                    </ItemDescription>
                  </ItemContent>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </button>
            </Item>
          )}
        />
      </ResourceSection>

      <ConfirmActionDialog
        open={Boolean(confirmDeleteAttachment)}
        onOpenChange={(open) => !open && setConfirmDeleteAttachment(null)}
        title="Delete attachment?"
        description={
          confirmDeleteAttachment
            ? `This permanently deletes ${attachmentFilename(confirmDeleteAttachment)} from the task.`
            : undefined
        }
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        variant="destructive"
        pending={attachmentDeletePending}
        onConfirm={() => {
          if (confirmDeleteAttachment) void onDeleteAttachment(confirmDeleteAttachment.id);
        }}      />
    </div>
  );
}
