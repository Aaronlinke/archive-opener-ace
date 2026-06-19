import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import JSZip from "jszip";
import { reconstructProgram } from "@/lib/ai-reconstruct.functions";

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

const EXT = {
  image: /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i,
  audio: /\.(mp3|wav|ogg|m4a|flac|aac)$/i,
  video: /\.(mp4|webm|ogv|mov|m4v)$/i,
  pdf: /\.pdf$/i,
  js: /\.m?js$/i,
  css: /\.css$/i,
  html: /\.html?$/i,
  md: /\.(md|markdown|mdx)$/i,
  py: /\.py$/i,
  exe: /\.(exe|msi|app|dmg|deb|rpm|appimage|apk|jar|bat|cmd|ps1|sh)$/i,
  text: /\.(txt|json|xml|csv|log|ya?ml|toml|ini|conf|env)$/i,
  code: /\.(ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|sql|swift|kt)$/i,
};

function pickEntryHtml(files: FileMap): string | null {
  const keys = Object.keys(files);
  const prefer = keys.find((k) => /(^|\/)index\.html?$/i.test(k));
  if (prefer) return prefer;
  const anyHtml = keys.find((k) => EXT.html.test(k));
  return anyHtml ?? null;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function classify(name: string): keyof typeof EXT | "other" {
  for (const k of Object.keys(EXT) as Array<keyof typeof EXT>) {
    if (EXT[k].test(name)) return k;
  }
  return "other";
}

function formatSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

function platformOf(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  if (/^(exe|msi|bat|cmd|ps1)$/.test(ext)) return "Windows";
  if (/^(app|dmg)$/.test(ext)) return "macOS";
  if (/^(deb|rpm|appimage|sh)$/.test(ext)) return "Linux";
  if (ext === "apk") return "Android";
  if (ext === "jar") return "Java";
  return "Programm";
}

async function extractStrings(blob: Blob, maxBytes = 2_000_000, minLen = 5, maxCount = 800): Promise<string[]> {
  const slice = blob.slice(0, Math.min(blob.size, maxBytes));
  const buf = new Uint8Array(await slice.arrayBuffer());
  const out: string[] = [];
  const seen = new Set<string>();
  // ASCII
  let cur = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 32 && b < 127) {
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= minLen && !seen.has(cur)) {
        seen.add(cur);
        out.push(cur);
        if (out.length >= maxCount) break;
      }
      cur = "";
    }
  }
  if (cur.length >= minLen && !seen.has(cur) && out.length < maxCount) out.push(cur);
  // UTF-16LE (häufig in PE-Resourcen für Menü-Texte)
  if (out.length < maxCount) {
    let s = "";
    for (let i = 0; i < buf.length - 1; i += 2) {
      const lo = buf[i], hi = buf[i + 1];
      if (hi === 0 && lo >= 32 && lo < 127) {
        s += String.fromCharCode(lo);
      } else {
        if (s.length >= minLen && !seen.has(s)) {
          seen.add(s);
          out.push(s);
          if (out.length >= maxCount) break;
        }
        s = "";
      }
    }
  }
  return out;
}


async function generateAutoViewer(files: FileMap, zipName: string): Promise<string> {
  const names = Object.keys(files).sort();
  const groups: Record<string, string[]> = {
    image: [], audio: [], video: [], pdf: [], js: [], css: [], md: [], py: [], exe: [], text: [], code: [], other: [],
  };
  for (const n of names) {
    const c = classify(n);
    if (c === "html") continue;
    (groups[c] ?? groups.other).push(n);
  }

  const onlyJs =
    groups.js.length > 0 &&
    groups.image.length === 0 && groups.audio.length === 0 &&
    groups.video.length === 0 && groups.pdf.length === 0 &&
    groups.py.length === 0 && groups.exe.length === 0 && groups.md.length === 0;
  if (onlyJs) {
    const scripts = groups.js.map((n) => `<script src="${files[n].url}"><\/script>`).join("\n");
    const styles = groups.css.map((n) => `<link rel="stylesheet" href="${files[n].url}">`).join("\n");
    return `<!doctype html><html><head><meta charset="utf-8"><title>JS Runner</title>${styles}
<style>body{margin:0;font-family:system-ui;padding:1rem}</style></head>
<body><div id="app"></div><div id="root"></div>${scripts}</body></html>`;
  }

  // README detection
  const readmeName =
    names.find((n) => /(^|\/)readme\.md$/i.test(n)) ||
    names.find((n) => /(^|\/)readme(\.txt)?$/i.test(n)) ||
    groups.md[0];
  let readmeRaw = "";
  let readmeIsMarkdown = false;
  if (readmeName) {
    readmeRaw = await files[readmeName].blob.text();
    readmeIsMarkdown = /\.(md|markdown|mdx)$/i.test(readmeName);
  }

  // Python entry
  const pyEntry =
    groups.py.find((n) => /(^|\/)(main|app|run|__main__)\.py$/i.test(n)) || groups.py[0] || null;

  // Pre-load all .py source as text for Pyodide
  const pyFiles: Array<{ path: string; content: string }> = [];
  for (const p of groups.py) {
    pyFiles.push({ path: p, content: await files[p].blob.text() });
  }

  // Pre-load code/text contents for inline viewer (cap large files)
  const codeFiles: Array<{ path: string; content: string; lang: string }> = [];
  const langFor = (n: string) => {
    const ext = n.split(".").pop()?.toLowerCase() ?? "";
    const map: Record<string, string> = {
      py: "python", js: "javascript", mjs: "javascript", ts: "typescript", tsx: "tsx", jsx: "jsx",
      html: "html", css: "css", json: "json", xml: "xml", yml: "yaml", yaml: "yaml",
      sh: "bash", bat: "dos", ps1: "powershell", sql: "sql", md: "markdown",
      java: "java", c: "c", cpp: "cpp", h: "c", cs: "csharp", go: "go", rs: "rust",
      rb: "ruby", php: "php", swift: "swift", kt: "kotlin",
    };
    return map[ext] ?? "plaintext";
  };
  for (const n of [...groups.code, ...groups.text, ...groups.js, ...groups.css, ...groups.md]) {
    if (n === readmeName) continue;
    const blob = files[n].blob;
    if (blob.size > 200_000) continue;
    codeFiles.push({ path: n, content: await blob.text(), lang: langFor(n) });
  }

  const totalSize = Object.values(files).reduce((a, f) => a + f.blob.size, 0);

  const section = (title: string, body: string) =>
    body ? `<section><h2>${title}</h2>${body}</section>` : "";

  const imgs = groups.image
    .map((n) => `<figure><img loading="lazy" src="${files[n].url}" alt="${escapeHtml(n)}"><figcaption>${escapeHtml(n)}</figcaption></figure>`)
    .join("");
  const auds = groups.audio
    .map((n) => `<div class="media"><p>${escapeHtml(n)}</p><audio controls src="${files[n].url}"></audio></div>`)
    .join("");
  const vids = groups.video
    .map((n) => `<div class="media"><p>${escapeHtml(n)}</p><video controls src="${files[n].url}"></video></div>`)
    .join("");
  const pdfs = groups.pdf
    .map((n) => `<div class="media"><p>${escapeHtml(n)}</p><iframe src="${files[n].url}" title="${escapeHtml(n)}"></iframe></div>`)
    .join("");

  const exeCards = groups.exe
    .map((n) => {
      const ext = (n.split(".").pop() ?? "").toLowerCase();
      const platform =
        /exe|msi|bat|cmd|ps1/.test(ext) ? "Windows" :
        /app|dmg/.test(ext) ? "macOS" :
        /deb|rpm|appimage|sh/.test(ext) ? "Linux" :
        /apk/.test(ext) ? "Android" :
        /jar/.test(ext) ? "Java" : "Programm";
      return `<div class="exe"><div><strong>${escapeHtml(n.split("/").pop() ?? n)}</strong>
        <div class="meta">${platform} · ${formatSize(files[n].blob.size)}</div>
        <div class="meta">${escapeHtml(n)}</div></div>
        <a class="btn" href="${files[n].url}" download="${escapeHtml(n.split("/").pop() ?? n)}">⬇ Download</a></div>`;
    })
    .join("");

  const othersList = groups.other
    .map((n) => `<li><a href="${files[n].url}" download="${escapeHtml(n.split("/").pop() ?? n)}">${escapeHtml(n)}</a> <span class="muted">(${formatSize(files[n].blob.size)})</span></li>`)
    .join("");

  const fileTree = names
    .map((n) => `<li><span class="path">${escapeHtml(n)}</span> <span class="muted">${formatSize(files[n].blob.size)}</span> <a href="${files[n].url}" download="${escapeHtml(n.split("/").pop() ?? n)}">⬇</a></li>`)
    .join("");

  const pyButton = pyEntry
    ? `<section><h2>Python ausführen</h2>
      <div class="exe"><div><strong>${escapeHtml(pyEntry)}</strong><div class="meta">Wird im Browser via Pyodide gestartet (nur reines Python ohne native Module).</div></div>
      <button class="btn" id="runPy">▶ Ausführen</button></div>
      <pre id="pyOut" class="pyout">Bereit.</pre></section>`
    : "";

  const readmeBlock = readmeName
    ? `<section><h2>${escapeHtml(readmeName)}</h2><div id="readme" data-md="${readmeIsMarkdown ? "1" : "0"}"></div>
       <script type="application/json" id="readmeRaw">${escapeHtml(readmeRaw)}</script></section>`
    : "";

  const codeBlock = codeFiles.length
    ? `<section><h2>Quellcode</h2>
       <div class="codeWrap">
         <ul class="fileList">
           ${codeFiles.map((f, i) => `<li><button data-i="${i}"${i === 0 ? ' class="active"' : ""}>${escapeHtml(f.path)}</button></li>`).join("")}
         </ul>
         <pre><code id="codeView" class="hljs"></code></pre>
       </div>
       <script type="application/json" id="codeData">${escapeHtml(JSON.stringify(codeFiles))}</script></section>`
    : "";

  const body =
    (readmeBlock || "") +
    section("Bilder / Screenshots", imgs ? `<div class="grid">${imgs}</div>` : "") +
    section("Video", vids) +
    section("Audio", auds) +
    section("PDF", pdfs) +
    (pyButton || "") +
    section("Programme / Installer", exeCards ? `<div class="exeList">${exeCards}</div><p class="muted">Native Programme können im Browser nicht direkt gestartet werden – lade sie herunter und führe sie lokal aus.</p>` : "") +
    (codeBlock || "") +
    section("Alle Dateien", `<ul class="tree">${fileTree}</ul>`) +
    section("Weitere Downloads", othersList ? `<ul>${othersList}</ul>` : "");

  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(zipName)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0b0c;color:#e7e7ea;padding:1.25rem;line-height:1.55;max-width:1100px;margin-inline:auto}
  header.top{display:flex;align-items:center;gap:.75rem;padding-bottom:1rem;border-bottom:1px solid #27272a;margin-bottom:1rem}
  header.top .icon{font-size:2rem}
  header.top h1{margin:0;font-size:1.2rem}
  header.top .meta{font-size:.8rem;color:#a1a1aa}
  h2{font-size:.75rem;margin:2rem 0 .75rem;color:#a1a1aa;text-transform:uppercase;letter-spacing:.08em;font-weight:600}
  section:first-of-type h2{margin-top:.5rem}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:.75rem}
  figure{margin:0;background:#18181b;border:1px solid #27272a;border-radius:.6rem;overflow:hidden;cursor:zoom-in}
  figure img{display:block;width:100%;height:180px;object-fit:cover}
  figcaption{font-size:.7rem;padding:.4rem .5rem;color:#a1a1aa;word-break:break-all}
  .media{background:#18181b;border:1px solid #27272a;border-radius:.6rem;padding:.75rem;margin-bottom:.75rem}
  .media p{margin:0 0 .5rem;font-size:.8rem;color:#a1a1aa;word-break:break-all}
  audio,video{width:100%;display:block;border-radius:.25rem}
  video{max-height:70vh;background:#000}
  .media iframe{width:100%;height:80vh;border:0;background:#fff;border-radius:.25rem}
  ul{padding-left:1.25rem;margin:0}
  li{margin:.25rem 0;word-break:break-all}
  a{color:#60a5fa}
  .muted{color:#71717a;font-size:.75rem}
  .exeList{display:grid;gap:.5rem}
  .exe{display:flex;justify-content:space-between;align-items:center;gap:1rem;background:#18181b;border:1px solid #27272a;border-radius:.6rem;padding:.85rem 1rem}
  .exe .meta{font-size:.75rem;color:#a1a1aa;margin-top:.15rem}
  .btn{display:inline-block;background:#3b82f6;color:white;border:0;padding:.5rem .85rem;border-radius:.4rem;font-size:.8rem;font-weight:500;cursor:pointer;text-decoration:none;white-space:nowrap}
  .btn:hover{background:#2563eb}
  .pyout{background:#000;color:#a7f3d0;padding:.75rem;border-radius:.4rem;font-size:.78rem;max-height:300px;overflow:auto;margin-top:.5rem;white-space:pre-wrap}
  .codeWrap{display:grid;grid-template-columns:240px 1fr;gap:.75rem;background:#18181b;border:1px solid #27272a;border-radius:.6rem;overflow:hidden}
  @media (max-width:700px){.codeWrap{grid-template-columns:1fr}}
  .fileList{list-style:none;padding:.5rem;margin:0;max-height:500px;overflow:auto;border-right:1px solid #27272a;background:#101012}
  .fileList li{margin:0}
  .fileList button{width:100%;text-align:left;background:none;border:0;color:#d4d4d8;padding:.35rem .5rem;border-radius:.3rem;cursor:pointer;font-size:.75rem;word-break:break-all;font-family:ui-monospace,monospace}
  .fileList button:hover{background:#27272a}
  .fileList button.active{background:#3b82f6;color:white}
  pre{margin:0}
  .codeWrap pre{padding:0;max-height:500px;overflow:auto}
  .codeWrap code{display:block;padding:1rem;font-size:.75rem;font-family:ui-monospace,monospace}
  .tree{list-style:none;padding:0;max-height:280px;overflow:auto;background:#101012;border:1px solid #27272a;border-radius:.5rem;padding:.5rem}
  .tree li{display:flex;justify-content:space-between;align-items:center;gap:.5rem;font-family:ui-monospace,monospace;font-size:.72rem;padding:.15rem .3rem}
  .tree .path{flex:1;color:#d4d4d8}
  #readme{background:#18181b;border:1px solid #27272a;border-radius:.6rem;padding:1rem 1.25rem}
  #readme h1,#readme h2,#readme h3{color:#fafafa;text-transform:none;letter-spacing:0;margin:1rem 0 .5rem;font-weight:600}
  #readme h1{font-size:1.3rem;margin-top:0}
  #readme h2{font-size:1.1rem}
  #readme code{background:#27272a;padding:.1rem .3rem;border-radius:.2rem;font-size:.85em}
  #readme pre{background:#0b0b0c;padding:.75rem;border-radius:.4rem;overflow:auto}
  #readme pre code{background:none;padding:0}
  #readme img{max-width:100%;border-radius:.4rem}
  .lightbox{position:fixed;inset:0;background:rgba(0,0,0,.92);display:none;align-items:center;justify-content:center;z-index:100;padding:1rem;cursor:zoom-out}
  .lightbox.on{display:flex}
  .lightbox img{max-width:100%;max-height:100%;object-fit:contain}
</style></head>
<body>
<header class="top">
  <div class="icon">📦</div>
  <div>
    <h1>${escapeHtml(zipName)}</h1>
    <div class="meta">${names.length} Dateien · ${formatSize(totalSize)}</div>
  </div>
</header>
${body || "<p>Keine anzeigbaren Dateien gefunden.</p>"}
<div class="lightbox" id="lb"><img id="lbimg" alt=""></div>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/common.min.js"><\/script>
<script>
  // README
  const rawEl = document.getElementById('readmeRaw');
  if (rawEl) {
    const target = document.getElementById('readme');
    const raw = rawEl.textContent || '';
    if (target.dataset.md === '1' && window.marked) {
      target.innerHTML = window.marked.parse(raw);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = raw;
      target.appendChild(pre);
    }
  }
  // Code viewer
  const codeDataEl = document.getElementById('codeData');
  if (codeDataEl) {
    const data = JSON.parse(codeDataEl.textContent || '[]');
    const view = document.getElementById('codeView');
    const buttons = document.querySelectorAll('.fileList button');
    const show = (i) => {
      buttons.forEach(b => b.classList.toggle('active', Number(b.dataset.i) === i));
      view.className = 'hljs language-' + (data[i].lang || 'plaintext');
      view.textContent = data[i].content;
      if (window.hljs) window.hljs.highlightElement(view);
    };
    buttons.forEach(b => b.addEventListener('click', () => show(Number(b.dataset.i))));
    if (data.length) show(0);
  }
  // Lightbox for images
  const lb = document.getElementById('lb');
  const lbimg = document.getElementById('lbimg');
  document.querySelectorAll('figure img').forEach(img => {
    img.addEventListener('click', () => { lbimg.src = img.src; lb.classList.add('on'); });
  });
  lb.addEventListener('click', () => lb.classList.remove('on'));
  // Python via Pyodide
  const runBtn = document.getElementById('runPy');
  if (runBtn) {
    const out = document.getElementById('pyOut');
    const pyFiles = ${JSON.stringify(pyFiles)};
    const entry = ${JSON.stringify(pyEntry)};
    let pyodide = null;
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      out.textContent = 'Lade Pyodide (~10 MB) …\\n';
      try {
        if (!pyodide) {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
          await new Promise((res, rej) => { s.onload = res; s.onerror = rej; document.head.appendChild(s); });
          pyodide = await window.loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/' });
          pyodide.setStdout({ batched: (t) => { out.textContent += t + '\\n'; } });
          pyodide.setStderr({ batched: (t) => { out.textContent += '⚠ ' + t + '\\n'; } });
        }
        out.textContent += 'Schreibe Dateien …\\n';
        for (const f of pyFiles) {
          const parts = f.path.split('/');
          let dir = '';
          for (let i = 0; i < parts.length - 1; i++) {
            dir += (i ? '/' : '') + parts[i];
            try { pyodide.FS.mkdir('/' + dir); } catch {}
          }
          pyodide.FS.writeFile('/' + f.path, f.content);
        }
        out.textContent += '▶ Starte ' + entry + ' …\\n\\n';
        await pyodide.runPythonAsync('import sys; sys.path.insert(0, "/"); exec(open("/' + entry + '").read())');
        out.textContent += '\\n✓ Fertig.';
      } catch (e) {
        out.textContent += '\\n✗ Fehler: ' + (e && e.message ? e.message : e);
      } finally {
        runBtn.disabled = false;
      }
    });
  }
<\/script>
</body></html>`;
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
  const [aiBusy, setAiBusy] = useState(false);
  const [exeCandidate, setExeCandidate] = useState<{ name: string; blob: Blob } | null>(null);
  const [readmeText, setReadmeText] = useState<string>("");
  const [allNames, setAllNames] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const urlsRef = useRef<string[]>([]);
  const reconstruct = useServerFn(reconstructProgram);

  const cleanup = () => {
    urlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    urlsRef.current = [];
    setExeCandidate(null);
    setReadmeText("");
    setAllNames([]);
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
      if (entry) {
        setStatus(`Starte ${entry} …`);
        const html = await normalized[entry].blob.text();
        const rewritten = await rewriteHtml(html, entry, normalized);
        setSrcDoc(rewritten);
      } else {
        setStatus("Erstelle Viewer …");
        setSrcDoc(await generateAutoViewer(normalized, file.name));
      }
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
