import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation, useRouter } from "@tanstack/react-router";
import { CodeBlockPanel } from "@/components/patterns/CodeBlockPanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

type RouteErrorBoundaryInnerProps = {
  resetKey: string;
  onReset: () => void;
  children: ReactNode;
};

type RouteErrorBoundaryState = {
  error: Error | null;
};

class RouteErrorBoundaryInner extends Component<RouteErrorBoundaryInnerProps, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Page render failed", {
      error,
      componentStack: info.componentStack,
    });
  }

  override componentDidUpdate(prevProps: RouteErrorBoundaryInnerProps): void {
    // A render throw with no boundary unmounts the whole app, so navigating
    // away (back button included) can't recover without a hard refresh. We sit
    // above the routed <Outlet />, so reset whenever the route changes.
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle role="heading" aria-level={1}>
              This page hit an error
            </EmptyTitle>
            <EmptyDescription>
              Something went wrong while rendering this page. You can go back and try again, or reload.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Alert variant="destructive">
              <AlertTitle>Render error</AlertTitle>
              <AlertDescription>
                <CodeBlockPanel
                  bodyClassName="max-h-64"
                  code={error.message}
                  filename="render-error.txt"
                  syntaxHighlighting={false}
                />
              </AlertDescription>
            </Alert>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={this.props.onReset}>
                Go back
              </Button>
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload page
              </Button>
            </div>
          </EmptyContent>
        </Empty>
      </div>
    );
  }
}

export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const router = useRouter();
  const resetKey = `${location.pathname}${location.searchStr}`;

  return (
    <RouteErrorBoundaryInner resetKey={resetKey} onReset={() => router.history.back()}>
      {children}
    </RouteErrorBoundaryInner>
  );
}
