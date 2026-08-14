import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Button } from "@/components/ui/button";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
  const [api, setApi] = useState<CarouselApi>();
  const [currentIndex, setCurrentIndex] = useState(0);
  const startIndex = useMemo(() => {
    if (items.length === 0) return 0;
    return Math.min(Math.max(initialIndex, 0), items.length - 1);
  }, [initialIndex, items.length]);
  const selectIndex = useCallback(
    (index: number) => {
      if (items.length === 0) return;
      const nextIndex = (index + items.length) % items.length;
      api?.scrollTo(nextIndex);
      setCurrentIndex(nextIndex);
    },
    [api, items.length],
  );

  useEffect(() => {
    if (!api) return;
    const updateSelection = () => {
      // Embla cannot calculate snaps without layout. The explicit state update
      // in `selectIndex` remains authoritative in jsdom and while a dialog is
      // being laid out; once measurable, Embla selection events take over.
      if (api.rootNode().clientWidth === 0) return;
      setCurrentIndex(api.selectedScrollSnap());
    };
    updateSelection();
    api.on("select", updateSelection);
    return () => {
      api.off("select", updateSelection);
    };
  }, [api]);

  useEffect(() => {
    if (!open) return;
    setCurrentIndex(startIndex);
  }, [open, startIndex]);

  useEffect(() => {
    if (!api || !open) return;
    api.scrollTo(startIndex, true);
  }, [api, open, startIndex]);

  useEffect(() => {
    if (!open || items.length < 2) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "ArrowRight") selectIndex(currentIndex + 1);
      if (event.key === "ArrowLeft") selectIndex(currentIndex - 1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [api, currentIndex, items.length, open, selectIndex]);

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
        <Carousel className="mx-12" opts={{ loop: items.length > 1, startIndex }} setApi={setApi}>
          <CarouselContent>
            {items.map((item, index) => {
              const itemFilename = attachmentFilename(item);
              return (
                <CarouselItem key={item.id} aria-label={`${index + 1} of ${items.length}`}>
                  <AspectRatio ratio={16 / 9}>
                    {isVideoLikeOutput(item.contentType, item.originalFilename) ? (
                      <video
                        src={item.contentPath}
                        className="size-full object-contain"
                        controls
                        playsInline
                        aria-label={itemFilename}
                      />
                    ) : (
                      <img
                        src={item.contentPath}
                        alt={itemFilename}
                        className="size-full object-contain"
                        draggable={false}
                      />
                    )}
                  </AspectRatio>
                </CarouselItem>
              );
            })}
          </CarouselContent>
          {items.length > 1 ? (
            <>
              <CarouselPrevious onClick={() => selectIndex(currentIndex - 1)} />
              <CarouselNext onClick={() => selectIndex(currentIndex + 1)} />
            </>
          ) : null}
        </Carousel>
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
