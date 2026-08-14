import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Reel,
  ReelContent,
  ReelControls,
  ReelItem,
  ReelNextButton,
  ReelPreviousButton,
  type ReelItem as KiboReelItem,
} from "@/components/kibo-ui/reel";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MediaVideoPlayer } from "@/components/MediaVideoPlayer";
import { ZoomableImage } from "@/components/patterns/ZoomableImage";
import { attachmentDownloadPath, attachmentFilename } from "@/lib/task-attachments";
import { isVideoLikeOutput } from "@/lib/task-output";

export interface GalleryMediaItem {
  id: string;
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
  contentType: string;
  originalFilename: string | null;
}

interface ImageGalleryModalProps {
  items: GalleryMediaItem[];
  initialIndex: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImageGalleryModal({ items, initialIndex, open, onOpenChange }: ImageGalleryModalProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const startIndex = useMemo(() => {
    if (items.length === 0) return 0;
    return Math.min(Math.max(initialIndex, 0), items.length - 1);
  }, [initialIndex, items.length]);
  const reelItems = useMemo<KiboReelItem[]>(
    () =>
      items.map((item) => ({
        id: item.id,
        type: isVideoLikeOutput(item.contentType, item.originalFilename) ? "video" : "image",
        src: item.contentPath,
        duration: 3600,
        alt: attachmentFilename(item),
        title: attachmentFilename(item),
      })),
    [items],
  );

  useEffect(() => {
    if (!open) return;
    setCurrentIndex(startIndex);
  }, [open, startIndex]);

  useEffect(() => {
    if (!open || items.length < 2) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "ArrowRight") setCurrentIndex((currentIndex + 1) % items.length);
      if (event.key === "ArrowLeft") setCurrentIndex((currentIndex - 1 + items.length) % items.length);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentIndex, items.length, open]);

  const current = items[currentIndex];
  if (!current) return null;
  const filename = attachmentFilename(current);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{filename}</DialogTitle>
          <DialogDescription>
            {currentIndex + 1} / {items.length}
          </DialogDescription>
        </DialogHeader>
        <Reel
          data={reelItems}
          index={currentIndex}
          onIndexChange={setCurrentIndex}
          autoPlay={false}
          className="aspect-video h-auto w-full"
          aria-label="Attachment gallery"
        >
          <ReelContent>
            {(_reelItem, index) => {
              const item = items[index];
              const itemFilename = attachmentFilename(item);
              return (
                <ReelItem aria-label={`${index + 1} of ${items.length}`}>
                  {isVideoLikeOutput(item.contentType, item.originalFilename) ? (
                    <MediaVideoPlayer src={item.contentPath} playsInline aria-label={itemFilename} />
                  ) : (
                    <ZoomableImage
                      src={item.contentPath}
                      alt={itemFilename}
                      className="size-full object-contain"
                      draggable={false}
                      zoomClassName="size-full"
                    />
                  )}
                </ReelItem>
              );
            }}
          </ReelContent>
          {items.length > 1 ? (
            <ReelControls className="pointer-events-none top-1/2 bottom-auto -translate-y-1/2 bg-none p-2">
              <ReelPreviousButton className="pointer-events-auto" />
              <ReelNextButton className="pointer-events-auto" />
            </ReelControls>
          ) : null}
        </Reel>
        <Button variant="outline" asChild>
          <a href={attachmentDownloadPath(current)} download={filename} aria-label={`Download ${filename}`}>
            <Download />
            Download
          </a>
        </Button>
      </DialogContent>
    </Dialog>
  );
}
