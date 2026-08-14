import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { Download, ExternalLink, Paperclip, Play } from "lucide-react";
import type { CompanyArtifact } from "@/api/artifacts";
import { Link } from "@tanstack/react-router";
import { useCompanyRouteId } from "@/hooks/useCompanyRouteId";
import { cn, formatDate } from "@/lib/utils";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface ArtifactCardProps {
  artifact: CompanyArtifact;
}

function PlaceholderPreview({ label }: { label?: string }) {
  return (
    <AspectRatio
      ratio={16 / 9}
      className="relative flex w-full items-center justify-center overflow-hidden bg-muted"
    >
      <div className="flex flex-col items-center gap-1.5 text-muted-foreground/50">
        <Paperclip className="h-7 w-7" aria-hidden="true" />
        {label ? (
          <span className="text-(length:--text-micro) font-medium uppercase tracking-wide">{label}</span>
        ) : null}
      </div>
    </AspectRatio>
  );
}

function ImagePreview({ artifact }: { artifact: CompanyArtifact }) {
  const [errored, setErrored] = useState(false);
  if (errored || !artifact.contentPath) {
    return <PlaceholderPreview label="Image" />;
  }
  return (
    <AspectRatio ratio={16 / 9} className="relative w-full overflow-hidden bg-muted">
      <img
        src={artifact.contentPath}
        alt={artifact.title}
        loading="lazy"
        className="h-full w-full object-cover"
        onError={() => setErrored(true)}
      />
    </AspectRatio>
  );
}

function VideoPreview({ artifact }: { artifact: CompanyArtifact }) {
  const [errored, setErrored] = useState(false);
  const [frameReady, setFrameReady] = useState(false);
  const thumbnailSeekRequested = useRef(false);
  const frameReadyFallbackTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (frameReadyFallbackTimer.current !== null) {
        window.clearTimeout(frameReadyFallbackTimer.current);
      }
    };
  }, []);
  if (errored || !artifact.contentPath) {
    return (
      <AspectRatio
        ratio={16 / 9}
        className="relative flex w-full items-center justify-center overflow-hidden bg-black/80"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white/15">
          <Play className="h-5 w-5 translate-x-0.5 text-white" aria-hidden="true" />
        </div>
      </AspectRatio>
    );
  }

  const markFrameReady = () => {
    if (frameReadyFallbackTimer.current !== null) {
      window.clearTimeout(frameReadyFallbackTimer.current);
      frameReadyFallbackTimer.current = null;
    }
    setFrameReady(true);
  };
  const scheduleFrameReadyFallback = () => {
    if (frameReadyFallbackTimer.current !== null) {
      window.clearTimeout(frameReadyFallbackTimer.current);
    }
    frameReadyFallbackTimer.current = window.setTimeout(markFrameReady, 3000);
  };
  const loadThumbnailFrame = (event: SyntheticEvent<HTMLVideoElement>) => {
    if (thumbnailSeekRequested.current) return;
    thumbnailSeekRequested.current = true;
    const video = event.currentTarget;
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const seekTarget = duration > 0 ? Math.min(0.12, duration / 2) : 0.05;
    try {
      if (Math.abs(video.currentTime - seekTarget) > 0.001) {
        video.currentTime = seekTarget;
        scheduleFrameReadyFallback();
      } else {
        markFrameReady();
      }
    } catch {
      markFrameReady();
    }
  };
  const handleLoadedData = (event: SyntheticEvent<HTMLVideoElement>) => {
    if (thumbnailSeekRequested.current || event.currentTarget.currentTime > 0) {
      markFrameReady();
    }
  };

  return (
    <AspectRatio ratio={16 / 9} className="relative w-full overflow-hidden bg-black">
      <video
        src={artifact.contentPath}
        preload="metadata"
        muted
        playsInline
        data-frame-ready={frameReady ? "true" : "false"}
        className={cn(
          "h-full w-full object-contain transition-opacity",
          frameReady ? "opacity-100" : "opacity-0",
        )}
        onLoadedMetadata={loadThumbnailFrame}
        onLoadedData={handleLoadedData}
        onSeeked={markFrameReady}
        onError={() => setErrored(true)}
      />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55">
          <Play className="h-5 w-5 translate-x-0.5 text-white" aria-hidden="true" />
        </div>
      </div>
    </AspectRatio>
  );
}

function TextPreview({ artifact }: { artifact: CompanyArtifact }) {
  const preview = artifact.previewText?.trim();
  if (!preview) {
    return <PlaceholderPreview label={artifact.source === "document" ? "Document" : "Text"} />;
  }
  return (
    <AspectRatio ratio={16 / 9} className="relative w-full overflow-hidden bg-card">
      <div className="absolute inset-0 overflow-hidden p-3">
        <p className="max-h-full overflow-hidden whitespace-pre-wrap break-words text-base leading-6 text-muted-foreground/75">
          {preview}
        </p>
      </div>
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-card to-transparent" />
    </AspectRatio>
  );
}

export function ArtifactPreview({ artifact }: { artifact: CompanyArtifact }) {
  switch (artifact.mediaKind) {
    case "image":
      return <ImagePreview artifact={artifact} />;
    case "video":
      return <VideoPreview artifact={artifact} />;
    case "text":
    case "document":
      return <TextPreview artifact={artifact} />;
    case "file":
      return <PlaceholderPreview label="File" />;
    case "empty":
    default:
      return <PlaceholderPreview />;
  }
}

export function ArtifactCard({ artifact }: ArtifactCardProps) {
  const companyId = useCompanyRouteId();
  return (
    <Card
      data-testid="artifact-card"
      data-media-kind={artifact.mediaKind}
      className="group relative cursor-pointer gap-0 overflow-hidden py-0"
    >
      <Link
        to="/$companyId/tasks/$taskNumber"
        params={{ companyId, taskNumber: String(artifact.task.taskNumber) }}
        hash={artifact.taskFragment}
        aria-label={`Open ${artifact.title} in ${artifact.task.identifier}`}
        className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <ArtifactPreview artifact={artifact} />

      <CardContent className="flex flex-1 flex-col gap-1 p-3">
        <div className="flex h-7 items-start justify-between gap-2">
          <h3
            className="min-w-0 flex-1 truncate text-sm font-medium leading-7 text-foreground/85"
            title={artifact.title}
          >
            {artifact.title}
          </h3>
          <div className="relative z-20 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {artifact.openPath ? (
              <Button asChild variant="ghost" size="icon-sm">
                <a
                  href={artifact.openPath}
                  target="_blank"
                  rel="noreferrer"
                  title="Open file in new tab"
                  aria-label="Open file in new tab"
                  onClick={(event) => event.stopPropagation()}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </Button>
            ) : null}
            {artifact.downloadPath ? (
              <Button asChild variant="ghost" size="icon-sm">
                <a
                  href={artifact.downloadPath}
                  download=""
                  title="Download file"
                  aria-label="Download file"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Download className="h-3.5 w-3.5" />
                </a>
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-0.5 flex items-center gap-1.5 text-(length:--text-micro) text-muted-foreground/65">
          <span>Last edited {formatDate(artifact.updatedAt)}</span>
          {artifact.createdByAgent ? (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span className="truncate">{artifact.createdByAgent.name}</span>
            </>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
