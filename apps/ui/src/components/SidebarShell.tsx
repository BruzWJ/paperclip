import { Sidebar as ShadcnSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEventHandler,
  type KeyboardEvent,
  type MouseEventHandler,
  type PointerEvent,
  type ReactNode,
} from "react";

const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_WIDTH_STEP = 16;
export const SIDEBAR_RAIL_WIDTH = 64;

function clampSidebarWidth(width: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readStoredSidebarWidth(storageKey: string) {
  if (typeof window === "undefined") return DEFAULT_SIDEBAR_WIDTH;
  try {
    const parsed = Number.parseInt(window.localStorage.getItem(storageKey) ?? "", 10);
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function writeStoredSidebarWidth(storageKey: string, width: number) {
  try {
    window.localStorage.setItem(storageKey, String(clampSidebarWidth(width)));
  } catch {
    // Resizing remains available when storage is unavailable.
  }
}

type SidebarShellProps = {
  children: ReactNode;
  open: boolean;
  collapsed?: boolean;
  peeking?: boolean;
  resizable?: boolean;
  storageKey?: string;
  className?: string;
  onPanelMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onPanelMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onPanelFocusCapture?: FocusEventHandler<HTMLDivElement>;
  onPanelBlurCapture?: FocusEventHandler<HTMLDivElement>;
};

/**
 * Paperclip-specific sizing adapter around shadcn Sidebar. The primitive owns
 * icon collapse and the mobile Sheet; this layer only adds persisted resizing
 * and the expanded overlay used while peeking from the collapsed rail.
 */
export function SidebarShell({
  children,
  open,
  collapsed = false,
  peeking = false,
  resizable = false,
  storageKey = "paperclip.sidebar.width",
  className,
  onPanelMouseEnter,
  onPanelMouseLeave,
  onPanelFocusCapture,
  onPanelBlurCapture,
}: SidebarShellProps) {
  const [width, setWidth] = useState(() => readStoredSidebarWidth(storageKey));
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(width);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);
  const canResize = resizable && open && !collapsed;

  useEffect(() => {
    const storedWidth = readStoredSidebarWidth(storageKey);
    widthRef.current = storedWidth;
    setWidth(storedWidth);
  }, [storageKey]);

  const commitWidth = useCallback(
    (nextWidth: number) => {
      const clamped = clampSidebarWidth(nextWidth);
      widthRef.current = clamped;
      setWidth(clamped);
      writeStoredSidebarWidth(storageKey, clamped);
    },
    [storageKey],
  );

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!canResize) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      dragState.current = {
        startX: event.clientX,
        startWidth: widthRef.current,
      };
      setIsResizing(true);
    },
    [canResize],
  );
  const handlePointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    const nextWidth = dragState.current.startWidth + event.clientX - dragState.current.startX;
    widthRef.current = clampSidebarWidth(nextWidth);
    setWidth(widthRef.current);
  }, []);
  const endResize = useCallback(() => {
    if (!dragState.current) return;
    dragState.current = null;
    setIsResizing(false);
    writeStoredSidebarWidth(storageKey, widthRef.current);
  }, [storageKey]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!canResize) return;
      const next =
        event.key === "ArrowLeft"
          ? width - SIDEBAR_WIDTH_STEP
          : event.key === "ArrowRight"
            ? width + SIDEBAR_WIDTH_STEP
            : event.key === "Home"
              ? MIN_SIDEBAR_WIDTH
              : event.key === "End"
                ? MAX_SIDEBAR_WIDTH
                : null;
      if (next === null) return;
      event.preventDefault();
      commitWidth(next);
    },
    [canResize, commitWidth, width],
  );

  return (
    <div
      data-sidebar-shell=""
      className={cn(
        "contents md:relative md:block md:h-full md:shrink-0 [&_[data-slot=sidebar-container]]:transition-none [&_[data-slot=sidebar-gap]]:transition-none",
        !open && "md:hidden",
        className,
      )}
      style={
        {
          "--sidebar-width": `${width}px`,
          "--sidebar-width-icon": `${SIDEBAR_RAIL_WIDTH}px`,
        } as CSSProperties
      }
    >
      <ShadcnSidebar
        collapsible="icon"
        data-sidebar-overlay={peeking ? "" : undefined}
        className={cn(
          "max-md:w-60 max-md:pt-(--sz-safe-top) md:!absolute md:!inset-y-0 md:!h-full",
          peeking &&
            "md:!w-(--sidebar-width) md:z-30 md:border-r md:border-border md:bg-background md:shadow-lg",
        )}
        onMouseEnter={onPanelMouseEnter}
        onMouseLeave={onPanelMouseLeave}
        onFocusCapture={onPanelFocusCapture}
        onBlurCapture={onPanelBlurCapture}
      >
        {children}
        {canResize ? (
          <div
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={width}
            tabIndex={0}
            className={cn(
              "absolute inset-y-0 right-0 z-20 w-3 cursor-col-resize touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors",
              "hover:before:bg-border focus-visible:before:bg-ring",
              isResizing && "before:bg-ring",
            )}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onLostPointerCapture={endResize}
            onKeyDown={handleKeyDown}
          />
        ) : null}
      </ShadcnSidebar>
    </div>
  );
}
