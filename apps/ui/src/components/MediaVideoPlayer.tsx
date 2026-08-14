import type { ComponentProps } from "react";
import { MediaFullscreenButton } from "media-chrome/react";
import {
  VideoPlayer,
  VideoPlayerContent,
  VideoPlayerControlBar,
  VideoPlayerMuteButton,
  VideoPlayerPlayButton,
  VideoPlayerSeekBackwardButton,
  VideoPlayerSeekForwardButton,
  VideoPlayerTimeDisplay,
  VideoPlayerTimeRange,
  VideoPlayerVolumeRange,
} from "@/components/kibo-ui/video-player";
import { cn } from "@/lib/utils";

interface MediaVideoPlayerProps extends Omit<
  ComponentProps<typeof VideoPlayerContent>,
  "className" | "controls" | "slot"
> {
  className?: string;
  videoClassName?: string;
}

export function MediaVideoPlayer({ className, videoClassName, ...props }: MediaVideoPlayerProps) {
  return (
    <VideoPlayer data-slot="media-video-player" className={cn("block size-full overflow-hidden", className)}>
      <VideoPlayerContent
        {...props}
        slot="media"
        className={cn("size-full object-contain", videoClassName)}
      />
      <VideoPlayerControlBar data-slot="media-video-player-controls">
        <VideoPlayerPlayButton />
        <VideoPlayerSeekBackwardButton />
        <VideoPlayerSeekForwardButton />
        <VideoPlayerTimeRange />
        <VideoPlayerTimeDisplay showDuration />
        <VideoPlayerMuteButton />
        <VideoPlayerVolumeRange />
        <MediaFullscreenButton className="p-2.5" />
      </VideoPlayerControlBar>
    </VideoPlayer>
  );
}
