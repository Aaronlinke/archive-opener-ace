import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type StageId =
  | "allrounder"
  | "script"
  | "coder"
  | "automator"
  | "network"
  | "hunter"
  | "team";

const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

/** Kurze, schnelle Modelle für Zwischenschritte, stärkeres Modell fürs Finale. */
const MODEL_FAST = "google/gemini-3-flash-preview";
const MODEL_STRONG = "google/gemini-3.1-pro-preview";

const BAN = `HARTE REGEL: Keine Science-Fiction-, Fantasy- oder Mythologie-Begriffe.
Verboten sind u.a.: Transformer(s), Autobot, Roboter-Metaphern, Matrix, Nexus, Orakel, Titan, Phoenix, Hydra, Odin, Thor, Zeus, Genesis, Quantum-Magie, "KI-Bewusstsein".
Schreibe nüchtern, technisch, konkret. Keine Marketing-Sprache.`;

const BREVITY = `Antworte maximal halb so lang wie du normalerweise würdest. Stichpunkte statt Prosa. Kein Vorwort, kein Fazit-Absatz.`;

const STAGES: Record<StageId, { title: string; model: string; system: string }> = {
  allrounder: {
    title: "Allrounder",
    model: MODEL_FAST,
    system: `Du bist der Allrounder. Du nimmst den Roh-Prompt des Nutzers und baust daraus so weit wie möglich eine vollständige Aufgabenbeschreibung:
Ziel, Nutzer, Ein-/Ausgaben, Funktionsumfang, Nicht-Ziele, Randfälle, Erfolgskriterien.
Lücken füllst du mit der plausibelsten Annahme und markierst sie als "Annahme:".`,
  },
  script: {
    title: "Script-Bauer",
    model: MODEL_FAST,
    system: `Du bist der Script-Bauer. Du überarbeitest die Aufgabenbeschreibung, entfernst jeden Science-Fiction-, Fantasy- und Mythologie-Begriff und ersetzt ihn durch die exakte technische Entsprechung.
Danach nutzt du die beigefügten Rechercheergebnisse (Unteragenten) und filterst daraus die eine beste Lösung heraus. Begründe die Auswahl in einem Satz pro Alternative.
Ergebnis: bereinigte Spezifikation + gewählter Lösungsweg + verworfene Alternativen.`,
  },
  coder: {
    title: "Code-Coder",
    model: MODEL_STRONG,
    system: `Du bist der Code-Generator mit perfektionistischen Maßstäben.
Regeln:
- Keine fremden Kryptografie-Bibliotheken und keine Ableitungen davon: Primitive werden selbst implementiert und dokumentiert (inkl. konstanter Laufzeit, Test-Vektoren).
- Du nimmst bewährte Grundgerüste bestehender Systeme als Vorlage und verbesserst sie messbar.
- Persistenz/Speichern ist immer Teil der Lösung.
Liefere lauffähigen Code in Blöcken mit Dateipfad als Überschrift, plus je Datei zwei Sätze Begründung.`,
  },
  automator: {
    title: "Automatisierer",
    model: MODEL_FAST,
    system: `Du bist der Automatisierer. Du prüfst den Code auf fehlende oder verbesserbare Verbindungen zwischen den Teilen: Datenfluss, Fehlerpfade, Retries, Caching, Build-/Deploy-Schritte, Tests, Migrationen.
Ziel: aus einem kleinen Kern wächst automatisch das vollständige System (ein Einstiegspunkt erzeugt die restliche Struktur).
Liefere konkrete Patches/Ergänzungen, keine allgemeinen Ratschläge.`,
  },
  network: {
    title: "Netzwerk & Server",
    model: MODEL_FAST,
    system: `Du bist verantwortlich für Netzwerk und Server. Du entscheidest: Welche Transportwege (HTTP, WebSocket, SSE, P2P, lokal)? Braucht es überhaupt einen Server oder reicht Client-Logik plus lokale Persistenz?
Bewerte Latenz, Kosten, Angriffsfläche, Offline-Fähigkeit. Nenne genau eine Empfehlung plus Fallback.`,
  },
  hunter: {
    title: "Fehlerjäger",
    model: MODEL_STRONG,
    system: `Du bist der Fehlerjäger und denkst bei jedem Schritt mit.
Für jeden gefundenen Punkt: Alpha-Variante (aktuell) → Beta-Variante (besser) → Entscheidung, ob selbst geschrieben werden muss.
Liste Bugs, Race Conditions, Sicherheitslücken, undefinierte Zustände, fehlende Validierung — mit Fix.`,
  },
  team: {
    title: "Team-Finale",
    model: MODEL_STRONG,
    system: `Du bist das Team-Finale. Führe alle vorherigen Stufen zu einer einzigen, widerspruchsfreien Endlösung zusammen.
Ausgabe: 1) Kurzfassung der Lösung 2) finale Dateiliste mit Code 3) offene Risiken.
Nichts wiederholen, was bereits identisch in einer Stufe steht — nur das konsolidierte Endergebnis.`,
  },
};

async function callGateway(
  key: string,
  model: string,
  system: string,
  user: string,
  maxTokens?: number,
): Promise<string> {
  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Lovable-API-Key": key },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: `${system}\n\n${BAN}\n\n${BREVITY}` },
        { role: "user", content: user },
      ],
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    if (res.status === 429) throw new Error("Rate-Limit erreicht. Bitte kurz warten.");
    if (res.status === 402) throw new Error("AI-Credits aufgebraucht. Bitte Workspace aufladen.");
    if (res.status === 403) throw new Error("Zugriff blockiert (Workspace-Richtlinie).");
    throw new Error(`AI-Fehler ${res.status}: ${txt.slice(0, 200)}`);
  }
  const json = await res.json();
  return (json?.choices?.[0]?.message?.content ?? "").trim();
}

/**
 * Verschachtelte Recherche: Agent → Subagent → Unteragent.
 * Ebene 1 zerlegt die Frage, Ebene 2 beantwortet die Teilfragen,
 * Ebene 3 prüft jede Antwort gegen bekannte Fehlerquellen.
 */
async function researchChain(key: string, topic: string): Promise<string> {
  const split = await callGateway(
    key,
    MODEL_FAST,
    "Du bist Rechercheleiter. Zerlege die Aufgabe in maximal 3 präzise Teilfragen, die technisch entscheidbar sind. Nur die Fragen, nummeriert.",
    topic,
    500,
  );
  const questions = split
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);

  const answers = await Promise.all(
    questions.map(async (q) => {
      const answer = await callGateway(
        key,
        MODEL_FAST,
        "Du bist Subagent. Beantworte die Teilfrage konkret mit 2-3 Optionen samt Trade-offs. Sehr kurz.",
        `Kontext:\n${topic}\n\nTeilfrage: ${q}`,
        700,
      );
      const check = await callGateway(
        key,
        MODEL_FAST,
        "Du bist Unteragent (Prüfer). Prüfe die Antwort auf Fehler, veraltete Annahmen und versteckte Kosten. Nenne nur Korrekturen und die beste Option. Maximal 5 Zeilen.",
        `Teilfrage: ${q}\n\nAntwort:\n${answer}`,
        400,
      );
      return `### ${q}\n${answer}\n\n**Prüfung:** ${check}`;
    }),
  );

  return answers.join("\n\n");
}

export const runPipelineStage = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        stage: z.enum([
          "allrounder",
          "script",
          "coder",
          "automator",
          "network",
          "hunter",
          "team",
        ]),
        prompt: z.string().min(1).max(20000),
        context: z.string().max(120000).default(""),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("LOVABLE_API_KEY fehlt");

    const stage = STAGES[data.stage as StageId];
    const started = Date.now();

    let research = "";
    if (data.stage === "script") {
      research = await researchChain(key, `${data.prompt}\n\n${data.context}`.slice(0, 6000));
    }

    const user = [
      `Ursprünglicher Auftrag des Nutzers:\n${data.prompt}`,
      data.context ? `\nErgebnisse der vorherigen Stufen:\n${data.context}` : "",
      research ? `\nRechercheergebnisse (Subagenten/Unteragenten):\n${research}` : "",
      `\nDeine Stufe: ${stage.title}. Liefere nur dein Stufenergebnis.`,
    ].join("\n");

    const output = await callGateway(key, stage.model, stage.system, user);

    return {
      stage: data.stage,
      title: stage.title,
      model: stage.model,
      output,
      research: research || null,
      ms: Date.now() - started,
    };
  });
