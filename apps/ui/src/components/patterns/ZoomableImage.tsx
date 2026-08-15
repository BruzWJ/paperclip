import type { ComponentProps } from "react";

import { ImageZoom } from "@/components/kibo-ui/image-zoom";

export interface ZoomableImageProps extends ComponentProps<"img"> {
  zoomClassName?: string;
}

/** Native image adapter backed by Kibo's accessible image-zoom behavior. */
export function ZoomableImage({ zoomClassName, alt, ...props }: ZoomableImageProps) {
  return (
    <ImageZoom className={zoomClassName}>
      <img alt={alt ?? ""} {...props} />
    </ImageZoom>
  );
}
