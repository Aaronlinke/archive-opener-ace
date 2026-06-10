import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import JSZip from "jszip";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ZIP Web Runner" },
      { name: "description", content: "ZIP hochladen und die enthaltene Website direkt im Browser ausführen." },
    ],
  }),
  component: Index,
});

type FileMap = Record<string, { blob: Blob; url: string }>;

function pickEntryHtml(files: FileMap): string | null {
  const keys = Object.keys(files);
  const prefer = keys.find((k) => /(^|\/)index\.html?$/i.test(k));
  if (prefer) return prefer;
  const anyHtml = keys.find((k) => /\.html?$/i.test(k));
  return anyHtml ?? null;
}

function resolvePath(base: string, rel: string): string {
  if (/^([a-z]+:)?\/\//i.test(rel) || rel.startsWith("data:") || rel.startsWith("blob:") || rel.startsWith("#")) {
    return rel;
  }
  const baseParts = base.split("/").slice(0, -1);
  const relClean = rel.split("?")[0].split("#")[0];
  const parts = relClean.split("/");
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") baseParts.pop();
    else baseParts.push(p);
  }
  return baseParts.join("/");
}

async function rewriteHtml(html: string, entryPath: string, files: FileMap): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const attrTargets: Array<[string, string]> = [
    ["script[src]", "src"],
    ["link[href]", "href"],
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["video[src]", "src"],
    ["audio[src]", "src"],
    ["iframe[src]", "src"],
    ["a[href]", "href"],
  ];

  for (const [sel, attr] of attrTargets) {
    doc.querySelectorAll(sel).forEach((el) => {
      const val = el.getAttribute(attr);
      if (!val) return;
      const resolved = resolvePath(entryPath, val);
      if (files[resolved]) {
        el.setAttribute(attr, files[resolved].url);
      }
    });
  }

  // Inline CSS files so url(...) refs and @imports also work via blob.
  const linkEls = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
  for (const link of linkEls) {
    const href = link.getAttribute("href");
    if (!href) continue;
    const original = href.startsWith("blob:") ? null : href;
    const resolved = original ? resolvePath(entryPath, original) : null;
    if (resolved && files[resolved]) {
      const cssText = await files[resolved].blob.text();
      const rewritten = rewriteCss(cssText, resolved, files);
      const style = doc.createElement("style");
      style.textContent = rewritten;
      link.replaceWith(style);
    }
  }

  // Rewrite url(...) in inline <style> tags too.
  doc.querySelectorAll("style").forEach((s) => {
    if (s.textContent) s.textContent = rewriteCss(s.textContent, entryPath, files);
  });

  return "<!doctype html>\n" + doc.documentElement.outerHTML;
}

function rewriteCss(css: string, cssPath: string, files: FileMap): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => {
    if (/^([a-z]+:)?\/\//i.test(ref) || ref.startsWith("data:") || ref.startsWith("blob:")) return m;
    const resolved = resolvePath(cssPath, ref);
    if (files[resolved]) return `url(${files[resolved].url})`;
    return m;
  });
}

function Index() {
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [srcDoc, setSrcDoc] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);

  const cleanup = () => {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
  };

  const handleFile = useCallback(async (file: File) => {
    setError("");
    setSrcDoc("");
    setFileName(file.name);
    setStatus("ZIP wird geladen …");
    cleanup();

    try {
      const zip = await JSZip.loadAsync(file);
      const files: FileMap = {};
      const entries = Object.values(zip.files).filter((f) => !f.dir);
      let i = 0;
      for (const entry of entries) {
        i++;
        setStatus(`Entpacke ${i}/${entries.length}: ${entry.name}`);
        const blob = await entry.async("blob");
        const url = URL.createObjectURL(blob);
        urlsRef.current.push(url);
        files[entry.name] = { blob, url };
      }

      // Strip common single top-level folder prefix, e.g. "site/index.html"
      const topLevels = new Set(Object.keys(files).map((k) => k.split("/")[0]));
      let normalized = files;
      if (topLevels.size === 1) {
        const prefix = [...topLevels][0] + "/";
        if (Object.keys(files).every((k) => k.startsWith(prefix))) {
          normalized = {};
          for (const [k, v] of Object.entries(files)) normalized[k.slice(prefix.length)] = v;
        }
      }

      const entry = pickEntryHtml(normalized);
      if (!entry) {
        setStatus("");
        setError("Keine HTML-Datei in der ZIP gefunden. Es wird eine index.html (oder eine andere .html) benötigt.");
        return;
      }

      setStatus(`Starte ${entry} …`);
      const html = await normalized[entry].blob.text();
      const rewritten = await rewriteHtml(html, entry, normalized);
      setSrcDoc(rewritten);
      setStatus("");
    } catch (e) {
      console.error(e);
      setStatus("");
      setError(e instanceof Error ? e.message : "Unbekannter Fehler beim Entpacken.");
    }
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };

  const reset = () => {
    cleanup();
    setSrcDoc("");
    setFileName("");
    setError("");
    setStatus("");
    if (inputRef.current) inputRef.current.value = "";
  };

  if (srcDoc) {
    return (
      <div className="flex h-screen flex-col bg-background">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-card px-4 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{fileName}</p>
            <p className="text-xs text-muted-foreground">läuft in der Sandbox</p>
          </div>
          <button
            onClick={reset}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            Andere ZIP laden
          </button>
        </header>
        <iframe
          title="ZIP Preview"
          srcDoc={srcDoc}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-same-origin"
          className="h-full w-full flex-1 border-0 bg-white"
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">ZIP Web Runner</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Ziehe eine ZIP mit einem Web-Projekt (HTML/CSS/JS) hierher – sie wird sofort im Browser ausgeführt.
          </p>
        </div>

        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-10 text-center transition ${
            dragOver
              ? "border-primary bg-accent"
              : "border-border bg-card hover:border-primary/50 hover:bg-accent/50"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(f);
            }}
          />
          <div className="mb-3 text-4xl">📦</div>
          <p className="text-base font-medium text-foreground">ZIP auswählen oder hierher ziehen</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Wird lokal in deinem Browser entpackt – nichts wird hochgeladen.
          </p>
        </label>

        {status && (
          <p className="mt-4 text-center text-sm text-muted-foreground">{status}</p>
        )}
        {error && (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-center text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="mt-8 rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Funktioniert mit</p>
          <ul className="list-disc space-y-0.5 pl-5">
            <li>Statischen Websites (index.html + Assets)</li>
            <li>Vanilla JS / CSS Projekten</li>
            <li>Gebauten Web-Apps (z. B. Vite/CRA <code>dist</code>-Ordner als ZIP)</li>
          </ul>
          <p className="mt-2">
            Nicht unterstützt: Server-Code (Node/PHP), <code>fetch</code> auf relative Pfade ohne mit-gepackte Dateien.
          </p>
        </div>
      </div>
    </div>
  );
}
