import { db } from "./db";
import { generateText, geminiConfigured } from "./gemini";
import { getTopEvents, type EventSummary } from "./queries";

const DIGEST_EVENT_COUNT = 25;

export async function generateDigest(): Promise<string> {
    if (!geminiConfigured()) throw new Error("GEMINI_API_KEY no configurada");

    const events = getTopEvents(24, DIGEST_EVENT_COUNT);
    if (events.length === 0) throw new Error("No hay eventos en las últimas 24 h");

    const content = await generateText(buildPrompt(events));
    db.query("INSERT INTO digests (created_at, content) VALUES (?, ?)").run(Date.now(), content);
    return content;
}

export const getLatestDigest = () =>
    db
        .query<{ created_at: number; content: string }, []>(
            "SELECT created_at, content FROM digests ORDER BY created_at DESC LIMIT 1",
        )
        .get();

function buildPrompt(events: EventSummary[]): string {
    const lines = events.map(
        (event) =>
            `- ${event.title} [${event.categories.join(", ") || "sin categoría"}] ` +
            `(${event.source_count} medios, ${event.article_count} artículos)`,
    );
    return `Eres analista de inteligencia de fuentes abiertas.
Con esta lista de eventos de las últimas 24 horas, redacta en español un briefing en markdown con:
1. Resumen ejecutivo (máximo 5 líneas).
2. Eventos clave agrupados por categoría, indicando cuántos medios los respaldan.
3. Qué conviene vigilar en las próximas 24-72 h.
Usa únicamente la información de la lista; no añadas datos externos y señala la incertidumbre cuando haya pocos medios.

EVENTOS:
${lines.join("\n")}`;
}