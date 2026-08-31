import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { runPipelineStage, type StageId } from "@/lib/pipeline.functions";

export const Route = createFileRoute("/pipeline")({
  head: () => ({
    meta: [
      { title: "Code-Pipeline – vom Prompt zur fertigen Lösung" },
      {
        name: "description",
        content:
          "Sieben spezialisierte Stufen verwandeln einen Prompt in geprüften Code: Allrounder, Script-Bauer mit Recherche, Coder, Automatisierer, Netzwerk, Fehlerjäger und Finale.",
      },
      { property: "og:title", content: "Code-Pipeline – vom Prompt zur fertigen Lösung" },
      {
        property: "og:description",
        content: "Prompt eingeben, sieben Stufen laufen lassen, konsolidierten Code erhalten.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Pipeline,
});

const STAGES: Array<{ id: StageId; icon: string; title: string; desc: string }> = [
  { id: "allrounder", icon: "⚡", title: "Allrounder", desc: "Baut aus dem Prompt eine vollständige Spezifikation." },
  { id: "script", icon: "📜", title: "Script-Bauer", desc: "Bereinigt Begriffe, recherchiert über Sub- und Unteragenten." },
  { id: "coder", icon: "💻", title: "Code-Coder", desc: "Schreibt Code selbst, ohne fremde Krypto-Bibliotheken." },
  { id: "automator", icon: "🤖", title: "Automatisierer", desc: "Schließt fehlende Verbindungen im System." },
  { id: "network", icon: "🌐", title: "Netzwerk & Server", desc: "Entscheidet Transport, Server oder reine Logik." },
  { id: "hunter", icon: "🔧", title: "Fehlerjäger", desc: "Alpha gegen Beta, findet Bugs und Lücken." },
  { id: "team", icon: "👥", title: "Team-Finale", desc: "Konsolidiert alles zu einer Endlösung." },
];

type Result = {
  stage: StageId;
  title: string;
  model: string;
  output: string;
  research: string | null;
  ms: number;
};

const STORE_KEY = "pipeline-runs-v1";

function Pipeline() {
  const run = useServerFn(runPipelineStage);
  const [prompt, setPrompt] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [active, setActive] = useState<StageId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const abort = useRef(false);

  const start = useCallback(async () => {
    if (!prompt.trim() || active) return;
    abort.current = false;
    setError(null);
    setResults([]);
    const collected: Result[] = [];
    try {
      for (const s of STAGES) {
        if (abort.current) break;
        setActive(s.id);
        const context = collected
          .map((r) => `## ${r.title}\n${r.output}`)
          .join("\n\n")
          .slice(-100000);
        const res = (await run({ data: { stage: s.id, prompt, context } })) as Result;
        collected.push(res);
        setResults([...collected]);
        setOpen((o) => ({ ...o, [s.id]: s.id === "team" }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActive(null);
    }
  }, [prompt, active, run]);

  const stop = useCallback(() => {
    abort.current = true;
  }, []);

  const save = useCallback(() => {
    if (!results.length) return;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const list = raw ? (JSON.parse(raw) as unknown[]) : [];
      list.unshift({ at: Date.now(), prompt, results });
      localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 20)));
      setError(null);
    } catch {
      setError("Speichern fehlgeschlagen (Speicher voll?).");
    }
  }, [results, prompt]);

  const download = useCallback(() => {
    const md = [
      `# Pipeline-Lauf`,
      ``,
      `**Auftrag:** ${prompt}`,
      ``,
      ...results.map((r) => `## ${r.title} (${r.model}, ${(r.ms / 1000).toFixed(1)}s)\n\n${r.output}\n`),
    ].join("\n");
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "pipeline-ergebnis.md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }, [results, prompt]);

  const total = results.reduce((n, r) => n + r.ms, 0);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Code-Pipeline</h1>
          <Link to="/" className="text-xs text-muted-foreground underline">
            ZIP-Runner
          </Link>
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="Beschreibe, was gebaut werden soll …"
          className="w-full resize-y rounded-lg border border-border bg-card p-3 text-sm outline-none focus:border-primary"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={start}
            disabled={!!active || !prompt.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            {active ? "Läuft …" : "Pipeline starten"}
          </button>
          {active && (
            <button onClick={stop} className="rounded-md border border-border px-3 py-2 text-sm">
              Stoppen
            </button>
          )}
          {results.length > 0 && !active && (
            <>
              <button onClick={save} className="rounded-md border border-border px-3 py-2 text-sm">
                💾 Speichern
              </button>
              <button onClick={download} className="rounded-md border border-border px-3 py-2 text-sm">
                ⬇ Markdown
              </button>
              <span className="text-xs text-muted-foreground">
                gesamt {(total / 1000).toFixed(1)}s
              </span>
            </>
          )}
        </div>

        {error && (
          <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <ol className="mt-6 space-y-3">
          {STAGES.map((s) => {
            const res = results.find((r) => r.stage === s.id);
            const isActive = active === s.id;
            return (
              <li
                key={s.id}
                className={`rounded-lg border bg-card p-3 transition ${
                  isActive ? "border-primary" : "border-border"
                }`}
              >
                <button
                  onClick={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))}
                  className="flex w-full items-start gap-3 text-left"
                >
                  <span className="text-lg leading-none">{s.icon}</span>
                  <span className="flex-1">
                    <span className="block text-sm font-medium">{s.title}</span>
                    <span className="block text-xs text-muted-foreground">{s.desc}</span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {isActive ? "…" : res ? `${(res.ms / 1000).toFixed(1)}s` : ""}
                  </span>
                </button>

                {res && open[s.id] && (
                  <div className="mt-3 space-y-3 border-t border-border pt-3">
                    {res.research && (
                      <details className="rounded-md bg-muted/40 p-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground">
                          Recherche (Subagenten / Unteragenten)
                        </summary>
                        <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{res.research}</pre>
                      </details>
                    )}
                    <pre className="whitespace-pre-wrap break-words text-xs leading-relaxed">{res.output}</pre>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
