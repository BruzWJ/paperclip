import { useEffect, useId, useState } from "react";
import { AlertCircle } from "lucide-react";
import { CodeBlockPanel } from "@/components/patterns/CodeBlockPanel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";

let mermaidLoaderPromise: Promise<typeof import("mermaid").default> | null = null;

export function loadMermaid() {
  if (!mermaidLoaderPromise) {
    mermaidLoaderPromise = import("mermaid").then((module) => module.default);
  }
  return mermaidLoaderPromise;
}

export function MermaidDiagramBlock({ source, darkMode }: { source: string; darkMode: boolean }) {
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setSvg(null);
    setError(null);

    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: darkMode ? "dark" : "default",
          fontFamily: "inherit",
          suppressErrorRendering: true,
        });
        const rendered = await mermaid.render(`paperclip-mermaid-${renderId}`, source);
        if (!active) return;
        setSvg(rendered.svg);
      })
      .catch((err) => {
        if (!active) return;
        const message =
          err instanceof Error && err.message ? err.message : "Failed to render Mermaid diagram.";
        setError(message);
      });

    return () => {
      active = false;
    };
  }, [darkMode, renderId, source]);

  if (svg) {
    return (
      <div className="paperclip-mermaid">
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    );
  }

  return (
    <Alert variant={error ? "destructive" : "default"}>
      {error ? <AlertCircle /> : <Spinner />}
      <AlertTitle>{error ? "Unable to render Mermaid diagram" : "Rendering diagram"}</AlertTitle>
      <AlertDescription>
        {error ? <p>{error}</p> : null}
        <CodeBlockPanel code={source} filename="diagram.mmd" language="mermaid" bodyClassName="max-h-64" />
      </AlertDescription>
    </Alert>
  );
}
