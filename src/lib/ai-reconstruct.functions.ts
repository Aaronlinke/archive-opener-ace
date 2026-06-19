import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  name: z.string(),
  platform: z.string(),
  sizeBytes: z.number(),
  strings: z.array(z.string()).max(800),
  readme: z.string().max(20000).optional(),
  fileTree: z.array(z.string()).max(200).optional(),
});

export const reconstructProgram = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => Input.parse(data))
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY fehlt");

    const system = `Du bist ein Reverse-Engineering- und UI-Rekonstruktions-Experte.
Du erhältst Metadaten zu einem nativen Programm (z. B. eine .exe), das im Browser nicht direkt ausführbar ist.
Deine Aufgabe: Erzeuge ein vollständig funktionsfähiges, eigenständiges HTML-Dokument (HTML + CSS + JS in EINER Datei), das das Programm so gut wie möglich im Browser nachbildet.

Regeln:
- Antworte AUSSCHLIESSLICH mit dem rohen HTML, beginnend mit <!doctype html>. Keine Markdown-Codeblöcke, keine Erklärungen.
- Leite Zweck, Felder, Buttons, Menüs aus den embedded Strings, dem Dateinamen und der README ab.
- Wenn es offensichtlich ein Tool ist (Rechner, Konverter, Editor, Spiel, Form, Player), implementiere echte Logik in JS.
- Wenn der Zweck unklar ist, baue eine plausible Demo-Oberfläche mit den erkennbaren Beschriftungen.
- Oben im Body ein gelber Hinweis-Banner: "⚠ KI-Rekonstruktion – nicht das Original".
- Dunkles, modernes UI (system-ui Font, dunkler Hintergrund). Mobile-freundlich.
- Kein externes CDN, alles inline.`;

    const user = `Programm: ${data.name}
Plattform: ${data.platform}
Größe: ${data.sizeBytes} Bytes
${data.fileTree?.length ? `\nWeitere Dateien im ZIP:\n${data.fileTree.slice(0, 80).join("\n")}` : ""}
${data.readme ? `\nREADME:\n${data.readme.slice(0, 8000)}` : ""}

Embedded Strings (aus dem Binary extrahiert):
${data.strings.slice(0, 500).join("\n")}

Bitte rekonstruiere dieses Programm als interaktive Web-App.`;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": key,
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      if (res.status === 429) throw new Error("AI-Limit erreicht. Bitte später erneut versuchen.");
      if (res.status === 402) throw new Error("AI-Credits aufgebraucht. Bitte Workspace aufladen.");
      throw new Error(`AI-Fehler ${res.status}: ${txt.slice(0, 300)}`);
    }

    const json = await res.json();
    let html: string = json?.choices?.[0]?.message?.content ?? "";
    html = html.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
    if (!/<!doctype/i.test(html) && !/<html/i.test(html)) {
      html = `<!doctype html><html><body>${html}</body></html>`;
    }
    return { html };
  });
