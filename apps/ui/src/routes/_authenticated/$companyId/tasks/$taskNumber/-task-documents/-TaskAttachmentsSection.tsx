// Empty collections render dedicated UI when data.length === 0.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { TaskAttachment } from "@paperclipai/shared";
import { Download, ExternalLink, FileText, Maximize2, Paperclip, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Attachment as AttachmentShell,
  AttachmentAction,
  AttachmentActions as AttachmentActionGroup,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Card } from "@/components/ui/card";
import { MediaVideoPlayer } from "../../../../../../components/patterns/MediaVideoPlayer";
import { FoldCurtain } from "../../../../../../components/patterns/FoldCurtain";
import { MarkdownBody } from "../../../../../../features/markdown/MarkdownBody";
import { formatBytes, getOutputFileGlyph } from "@/lib/task-output";
import {
  attachmentDownloadPath,
  attachmentFilename,
  attachmentOpenPath,
  isImageAttachment,
  isMarkdownAttachment,
  isVideoAttachment,
} from "@/lib/task-attachments";
import { queryKeys } from "@/lib/queryKeys";
import { ConfirmActionDialog } from "@/components/patterns/ConfirmActionDialog";

interface TaskAttachmentsSectionProps {
  attachments: TaskAttachment[];
  error?: string | null;
  deletePending?: boolean;
  onDelete?: (attachmentId: string) => void;
  onImageClick: (attachment: TaskAttachment) => void;
}

interface AttachmentItemProps {
  attachment: TaskAttachment;
  onDelete?: (attachmentId: string) => void;
  deletePending?: boolean;
}

interface PreviewableAttachmentItemProps extends AttachmentItemProps {
  onPreview?: (attachment: TaskAttachment) => void;
}

async function fetchAttachmentText(attachment: TaskAttachment) {
  const response = await fetch(attachment.contentPath, {
    headers: { Accept: "text/markdown,text/plain;q=0.9,*/*;q=0.1" },
  });
  if (!response.ok) {
    throw new Error(`Unable to load attachment preview (${response.status})`);
  }
  return response.text();
}

function AttachmentActions({
  attachment,
  onDelete,
  deletePending,
  onPreview,
}: PreviewableAttachmentItemProps) {
  const filename = attachmentFilename(attachment);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {onPreview ? (
        <Button
          variant="ghost"
          size="icon-sm"
          title="Browse gallery"
          aria-label={`Browse ${filename} in gallery`}
          onClick={() => onPreview(attachment)}
        >
          <Maximize2 className="h-4 w-4"  data-icon="inline-start"/>
        </Button>
      ) : null}
      <Button asChild variant="ghost" size="icon-sm" title="Open in new tab">
        <a
          href={attachmentOpenPath(attachment)}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${filename}`}
        >
          <ExternalLink className="h-4 w-4"  data-icon="inline-start"/>
        </a>
      </Button>
      <Button asChild variant="ghost" size="icon-sm" title="Download">
        <a href={attachmentDownloadPath(attachment)} aria-label={`Download ${filename}`}>
          <Download className="h-4 w-4"  data-icon="inline-start"/>
        </a>
      </Button>
      {onDelete ? (
        <Button
          variant="ghost"
          size="icon-sm"
          title="Delete attachment"
          className="text-muted-foreground hover:text-destructive"
          onClick={() => onDelete(attachment.id)}
          disabled={deletePending}
        >
          <Trash2 className="h-4 w-4"  data-icon="inline-start"/>
        </Button>
      ) : null}
    </div>
  );
}

function AttachmentMeta({ attachment }: { attachment: TaskAttachment }) {
  return (
    <p className="mt-0.5 text-(length:--text-micro) text-muted-foreground">
      Attachment · {attachment.contentType} · {formatBytes(attachment.byteSize)}
    </p>
  );
}

function MarkdownAttachmentCard({ attachment, onDelete, deletePending }: AttachmentItemProps) {
  const filename = attachmentFilename(attachment);
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.tasks.attachmentPreview(attachment.id),
    queryFn: () => fetchAttachmentText(attachment),
  });

  return (
    <Card id={`attachment-${attachment.id}`} className="scroll-mt-20 gap-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground"  data-icon="inline-start"/>
            <span className="truncate text-sm font-medium" title={filename}>
              {filename}
            </span>
          </div>
          <AttachmentMeta attachment={attachment} />
        </div>
        <AttachmentActions attachment={attachment} onDelete={onDelete} deletePending={deletePending} />
      </div>
      <div className="rounded-md hover:bg-accent/10">
        {isLoading ? (
          <p className="px-1 py-2 text-xs text-muted-foreground" role="status">
            Loading preview...
          </p>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>Could not load markdown preview.</AlertDescription>
          </Alert>
        ) : (
          <FoldCurtain>
            <MarkdownBody
              className="paperclip-edit-in-place-content min-h-(--sz-220px) text-sm leading-7"
              softBreaks={false}
            >
              {data ?? ""}
            </MarkdownBody>
          </FoldCurtain>
        )}
      </div>
    </Card>
  );
}

function VideoAttachmentCard({
  attachment,
  onDelete,
  deletePending,
  onPreview,
}: PreviewableAttachmentItemProps) {
  const filename = attachmentFilename(attachment);
  return (
    <Card id={`attachment-${attachment.id}`} className="block scroll-mt-20 overflow-hidden py-0">
      <AspectRatio ratio={16 / 9} className="overflow-hidden bg-black">
        <MediaVideoPlayer
          src={attachment.contentPath}
          preload="metadata"
          playsInline
          aria-label={`Video output: ${filename}`}
        />
      </AspectRatio>
      <div className="flex flex-col gap-2 p-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <p className="break-words text-sm font-semibold text-foreground">{filename}</p>
          <AttachmentMeta attachment={attachment} />
        </div>
        <AttachmentActions
          attachment={attachment}
          onDelete={onDelete}
          deletePending={deletePending}
          onPreview={onPreview}
        />
      </div>
    </Card>
  );
}

function GenericAttachmentRow({ attachment, onDelete, deletePending }: AttachmentItemProps) {
  const filename = attachmentFilename(attachment);
  return (
    <AttachmentShell id={`attachment-${attachment.id}`} className="w-full flex-nowrap scroll-mt-20">
      <AttachmentMedia>
        <Badge
          variant="secondary"
          className="size-8 shrink-0 justify-center rounded-md border-0 p-0 text-(length:--text-nano) tabular-nums"
          aria-hidden="true"
        >
          {getOutputFileGlyph(attachment.contentType).label}
        </Badge>
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>
          <a
            href={attachmentOpenPath(attachment)}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-sm font-medium text-foreground hover:underline"
            title={filename}
          >
            {filename}
          </a>
        </AttachmentTitle>
        <AttachmentDescription className="text-(length:--text-micro)">
          Attachment · {attachment.contentType} · {formatBytes(attachment.byteSize)}
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentActionGroup>
        <AttachmentActions attachment={attachment} onDelete={onDelete} deletePending={deletePending} />
      </AttachmentActionGroup>
    </AttachmentShell>
  );
}

export function TaskAttachmentsSection({
  attachments,
  error,
  deletePending = false,
  onDelete,
  onImageClick,
}: TaskAttachmentsSectionProps) {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const { imageAttachments, markdownAttachments, videoAttachments, genericAttachments } = useMemo(() => {
    const images: TaskAttachment[] = [];
    const markdown: TaskAttachment[] = [];
    const videos: TaskAttachment[] = [];
    const generic: TaskAttachment[] = [];

    for (const attachment of attachments) {
      if (isImageAttachment(attachment)) images.push(attachment);
      else if (isMarkdownAttachment(attachment)) markdown.push(attachment);
      else if (isVideoAttachment(attachment)) videos.push(attachment);
      else generic.push(attachment);
    }

    return {
      imageAttachments: images,
      markdownAttachments: markdown,
      videoAttachments: videos,
      genericAttachments: generic,
    };
  }, [attachments]);

  const requestDelete = (attachmentId: string) => setConfirmDeleteId(attachmentId);
  const confirmDelete = (attachmentId: string) => {
    if (!onDelete) return;
    onDelete(attachmentId);
    setConfirmDeleteId(null);
  };

  return (
    <div className="space-y-3 rounded-lg">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Paperclip className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true"  data-icon="inline-start"/>
          <h3 className="text-sm font-medium text-muted-foreground">Attachments</h3>
          <span className="text-xs text-muted-foreground">{attachments.length}</span>
        </div>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {imageAttachments.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {imageAttachments.map((attachment) => (
            <AttachmentShell
              key={attachment.id}
              id={`attachment-${attachment.id}`}
              orientation="vertical"
              className="aspect-square w-full scroll-mt-20 overflow-hidden p-0"
            >
              <AttachmentMedia variant="image" className="h-full rounded-none">
                <img
                  src={attachment.contentPath}
                  alt={attachment.originalFilename ?? "attachment"}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </AttachmentMedia>
              <AttachmentTrigger
                onClick={() => onImageClick(attachment)}
                aria-label={`Preview ${attachment.originalFilename ?? "image attachment"}`}
              />
              {onDelete ? (
                <AttachmentActionGroup className="opacity-0 transition-opacity group-hover/attachment:opacity-100 focus-within:opacity-100">
                  <AttachmentAction
                    variant="destructive"
                    onClick={() => requestDelete(attachment.id)}
                    title="Delete attachment"
                  >
                    <Trash2 className="h-3.5 w-3.5"  data-icon="inline-start"/>
                  </AttachmentAction>
                </AttachmentActionGroup>
              ) : null}
            </AttachmentShell>
          ))}
        </div>
      )}

      {markdownAttachments.length > 0 && (
        <div className="space-y-3">
          {markdownAttachments.map((attachment) => (
            <MarkdownAttachmentCard
              key={attachment.id}
              attachment={attachment}
              onDelete={onDelete ? requestDelete : undefined}
              deletePending={deletePending}
            />
          ))}
        </div>
      )}

      {videoAttachments.length > 0 && (
        <div className="space-y-3">
          {videoAttachments.map((attachment) => (
            <VideoAttachmentCard
              key={attachment.id}
              attachment={attachment}
              onDelete={onDelete ? requestDelete : undefined}
              deletePending={deletePending}
              onPreview={onImageClick}
            />
          ))}
        </div>
      )}

      {genericAttachments.length > 0 && (
        <div className="space-y-2">
          {genericAttachments.map((attachment) => (
            <GenericAttachmentRow
              key={attachment.id}
              attachment={attachment}
              onDelete={onDelete ? requestDelete : undefined}
              deletePending={deletePending}
            />
          ))}
        </div>
      )}

      {onDelete && confirmDeleteId ? (
        <ConfirmActionDialog
          open
          onOpenChange={(open) => !open && setConfirmDeleteId(null)}
          title="Delete attachment?"
          description="This attachment will be permanently deleted."
          confirmLabel="Delete"
          pendingLabel="Deleting…"
          pending={deletePending}
          variant="destructive"
          onConfirm={() => confirmDelete(confirmDeleteId)}
        />
      ) : null}
    </div>
  );
}
