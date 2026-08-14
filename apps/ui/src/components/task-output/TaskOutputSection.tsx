import type { TaskWorkProduct } from "@paperclipai/shared";
import { Download, ExternalLink, Maximize2, Play } from "lucide-react";

import * as AttachmentUI from "@/components/ui/attachment";
import { Badge } from "@/components/ui/badge";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Button } from "@/components/ui/button";
import * as CardUI from "@/components/ui/card";
import { MediaVideoPlayer } from "@/components/MediaVideoPlayer";
import {
  formatBytes,
  getOutputFileGlyph,
  getTaskOutputs,
  isImageContentType,
  isVideoLikeOutput,
  outputFilename,
  type TaskOutputItem,
} from "@/lib/task-output";
import { relativeTime } from "@/lib/utils";

interface TaskOutputSectionProps {
  workProducts: TaskWorkProduct[] | null | undefined;
  resolveCreatorName?: (item: TaskOutputItem) => string | null;
  onMediaClick?: (item: TaskOutputItem) => void;
}

interface TaskOutputItemProps {
  item: TaskOutputItem;
  creatorName?: string | null;
}

interface InteractiveTaskOutputItemProps extends TaskOutputItemProps {
  onMediaClick?: (item: TaskOutputItem) => void;
}

function isMediaOutput(item: TaskOutputItem) {
  const meta = item.metadata;
  return Boolean(
    meta &&
    (isImageContentType(meta.contentType) || isVideoLikeOutput(meta.contentType, meta.originalFilename)),
  );
}

function outputMeta(item: TaskOutputItem, creatorName?: string | null) {
  const values = item.metadata ? [item.metadata.contentType, formatBytes(item.metadata.byteSize)] : [];
  if (creatorName) values.push(creatorName);
  values.push(relativeTime(item.createdAt));
  return values.join(" · ");
}

function MediaThumbnail({ item, creatorName, onMediaClick }: InteractiveTaskOutputItemProps) {
  const meta = item.metadata;
  if (!meta) return null;
  const filename = outputFilename(item);
  const video = isVideoLikeOutput(meta.contentType, meta.originalFilename);

  return (
    <AttachmentUI.Attachment orientation="vertical" size="sm" className="w-full">
      <AttachmentUI.AttachmentMedia variant="image" className="w-full">
        {video ? (
          <video
            src={meta.contentPath}
            className="size-full object-cover"
            muted
            playsInline
            preload="metadata"
          />
        ) : (
          <img src={meta.contentPath} alt={filename} className="size-full object-cover" loading="lazy" />
        )}
      </AttachmentUI.AttachmentMedia>
      <AttachmentUI.AttachmentContent>
        <AttachmentUI.AttachmentTitle title={filename}>{filename}</AttachmentUI.AttachmentTitle>
        <AttachmentUI.AttachmentDescription>
          {outputMeta(item, creatorName)}
        </AttachmentUI.AttachmentDescription>
      </AttachmentUI.AttachmentContent>
      {onMediaClick ? (
        <AttachmentUI.AttachmentTrigger
          aria-label={`Browse ${filename} in gallery`}
          onClick={() => onMediaClick(item)}
        />
      ) : (
        <AttachmentUI.AttachmentTrigger asChild>
          <a href={meta.openPath} target="_blank" rel="noreferrer" aria-label={`Open ${filename}`} />
        </AttachmentUI.AttachmentTrigger>
      )}
    </AttachmentUI.Attachment>
  );
}

function PrimaryOutput({ item, creatorName, onMediaClick }: InteractiveTaskOutputItemProps) {
  const meta = item.metadata;
  const filename = outputFilename(item);
  const video = Boolean(meta && isVideoLikeOutput(meta.contentType, meta.originalFilename));
  const image = Boolean(meta && isImageContentType(meta.contentType));
  const media = video || image;

  return (
    <CardUI.Card className="gap-0 overflow-hidden py-0">
      {video && meta ? (
        <AspectRatio ratio={16 / 9} className="overflow-hidden bg-black">
          <MediaVideoPlayer
            src={meta.contentPath}
            preload="metadata"
            playsInline
            aria-label={`Video output: ${filename}`}
          />
        </AspectRatio>
      ) : image && meta ? (
        <Button
          asChild={!onMediaClick}
          variant="ghost"
          className="h-auto aspect-video rounded-none bg-black p-0"
          aria-label={onMediaClick ? `Browse ${filename} in gallery` : `Open ${filename}`}
          onClick={() => onMediaClick?.(item)}
        >
          {onMediaClick ? (
            <img src={meta.contentPath} alt={filename} className="size-full object-contain" />
          ) : (
            <a href={meta.openPath} target="_blank" rel="noreferrer">
              <img src={meta.contentPath} alt={filename} className="size-full object-contain" />
            </a>
          )}
        </Button>
      ) : (
        <CardUI.CardContent className="flex aspect-video items-center justify-center">
          <Badge
            variant="secondary"
            className="size-16 shrink-0 justify-center rounded-md border-0 p-0 text-base tabular-nums"
            aria-hidden="true"
          >
            {getOutputFileGlyph(meta?.contentType).label}
          </Badge>
        </CardUI.CardContent>
      )}

      <CardUI.CardFooter className="gap-2 p-3">
        <CardUI.CardHeader className="min-w-0 flex-1 p-0">
          <CardUI.CardTitle className="truncate text-sm">{filename}</CardUI.CardTitle>
          <CardUI.CardDescription>
            {item.degraded ? "Output metadata is unavailable." : outputMeta(item, creatorName)}
          </CardUI.CardDescription>
        </CardUI.CardHeader>
        {item.isPrimary ? <Badge variant="secondary">Primary</Badge> : null}
        {meta ? (
          <>
            {media && onMediaClick ? (
              <Button variant="outline" size="sm" onClick={() => onMediaClick(item)}>
                <Maximize2 />
                Browse
              </Button>
            ) : null}
            {!media || !onMediaClick || video ? (
              <Button asChild variant="outline" size="sm">
                <a href={meta.openPath} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Open
                </a>
              </Button>
            ) : null}
            <Button asChild size="sm">
              <a href={meta.downloadPath} aria-label={`Download ${filename}`}>
                <Download />
                Download
              </a>
            </Button>
          </>
        ) : null}
      </CardUI.CardFooter>
    </CardUI.Card>
  );
}

function OutputRow({ item, creatorName }: TaskOutputItemProps) {
  const filename = outputFilename(item);
  const meta = item.metadata;
  return (
    <AttachmentUI.Attachment size="sm" className="w-full flex-nowrap">
      <AttachmentUI.AttachmentMedia>
        <Badge
          variant="secondary"
          className="size-8 shrink-0 justify-center rounded-md border-0 p-0 text-(length:--text-nano) tabular-nums"
          aria-hidden="true"
        >
          {getOutputFileGlyph(meta?.contentType).label}
        </Badge>
      </AttachmentUI.AttachmentMedia>
      <AttachmentUI.AttachmentContent>
        <AttachmentUI.AttachmentTitle title={filename}>{filename}</AttachmentUI.AttachmentTitle>
        <AttachmentUI.AttachmentDescription>
          {item.degraded ? "File details unavailable" : outputMeta(item, creatorName)}
        </AttachmentUI.AttachmentDescription>
      </AttachmentUI.AttachmentContent>
      {meta ? (
        <AttachmentUI.AttachmentActions>
          <AttachmentUI.AttachmentAction asChild title="Open in new tab">
            <a href={meta.openPath} target="_blank" rel="noreferrer" aria-label={`Open ${filename}`}>
              <ExternalLink />
            </a>
          </AttachmentUI.AttachmentAction>
          <AttachmentUI.AttachmentAction asChild title="Download">
            <a href={meta.downloadPath} aria-label={`Download ${filename}`}>
              <Download />
            </a>
          </AttachmentUI.AttachmentAction>
        </AttachmentUI.AttachmentActions>
      ) : null}
    </AttachmentUI.Attachment>
  );
}

export function TaskOutputSection({
  workProducts,
  resolveCreatorName,
  onMediaClick,
}: TaskOutputSectionProps) {
  const { primary, rest, count } = getTaskOutputs(workProducts);
  if (!primary) return null;

  const creatorFor = (item: TaskOutputItem) => resolveCreatorName?.(item) ?? null;
  const media = rest.filter(isMediaOutput);
  const files = rest.filter((item) => !isMediaOutput(item));

  return (
    <section className="space-y-3" aria-label="Task outputs">
      <header className="flex items-center gap-2">
        <Play className="size-4" aria-hidden="true" />
        <h3 className="text-sm font-medium">Output</h3>
        <Badge variant="secondary">{count}</Badge>
      </header>
      <div id={`work-product-${primary.id}`} className="scroll-mt-20">
        <PrimaryOutput item={primary} creatorName={creatorFor(primary)} onMediaClick={onMediaClick} />
      </div>
      {rest.length ? (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Also produced</h4>
          {media.length ? (
            <div className="grid grid-cols-4 gap-2">
              {media.map((item) => (
                <div key={item.id} id={`work-product-${item.id}`}>
                  <MediaThumbnail item={item} creatorName={creatorFor(item)} onMediaClick={onMediaClick} />
                </div>
              ))}
            </div>
          ) : null}
          {files.map((item) => (
            <div key={item.id} id={`work-product-${item.id}`}>
              <OutputRow item={item} creatorName={creatorFor(item)} />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
