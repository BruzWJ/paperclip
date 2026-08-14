import {
  Dropzone,
  DropzoneContent,
  DropzoneEmptyState,
  type DropzoneProps,
} from "@/components/kibo-ui/dropzone";

export type AccessibleDropzoneProps = Omit<DropzoneProps, "children">;

/** Canonical composition of Kibo's accessible Dropzone compatibility root. */
export function AccessibleDropzone(props: AccessibleDropzoneProps) {
  return (
    <Dropzone {...props}>
      <DropzoneContent />
      <DropzoneEmptyState />
    </Dropzone>
  );
}
