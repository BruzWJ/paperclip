import * as React from "react";
import { StrictMode } from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppCommandMenu } from "./routes/-AppCommandMenu";
import { Toaster } from "./components/ui/sonner";
import { ThemeProvider } from "./context/ThemeContext";
import { initPluginBridge } from "./plugins/bridge-init";
import { startPerfMeasureReaper } from "./lib/perf-measure-reaper";
import { createAppRouter } from "./router";
import "./index.css";

initPluginBridge(React, ReactDOM, ReactDOMClient);

// React 19.2 emits an unbounded stream of performance.measure() entries for its
// DevTools performance tracks and never clears them; on a long-lived tab they
// accumulate into millions of native objects (GBs). Reap them periodically.
startPerfMeasureReaper();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Keep inactive REST snapshots bounded in long-lived operator sessions.
      gcTime: 5 * 60_000,
      // Socket.IO owns domain freshness and reconciles active REST projections
      // after reconnects; browser focus/network listeners are not a second path.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});
const router = createAppRouter(queryClient);

ReactDOMClient.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Toaster position="bottom-left" visibleToasts={5} />
        <AppCommandMenu />
        <RouterProvider router={router} />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
