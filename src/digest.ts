import { HOUR_MS } from "./config";
import { db } from "./db";
import { generateText, geminiConfigured } from "./gemini";
import { getTopEvents, type EventSummary } from "./queries";

const DIGEST_EVENT_COUNT = 25;

export async function generateDigest(): Promise<string> {
    if (!geminiConfigured()) throw new Error("GEMINI_API_KEY no configurada");

    const events = getTopEvents({ hours: 24, limit: DIGEST_EVENT_COUNT });
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

function describe(event: EventSummary): string {
    const hoursAgo = Math.max(0, Math.round((Date.now() - event.first_seen_at) / HOUR_MS));
    const actors = event.actors.slice(0, 4).map((actor) => `${actor.name} (${actor.role})`).join(", ");
    const places = event.locations.slice(0, 3).map((place) => place.name).join(", ");

    const head =
        `- ${event.title} [${event.categories.join(", ") || "sin categoría"}] ` +
        `(${event.source_count} medios, ${event.article_count} artículos; ${event.status}; primera noticia hace ${hoursAgo} h)`;
    const details = [
        event.event_type && `tipo: ${event.event_type}`,
        actors && `actores: ${actors}`,
        places && `lugares: ${places}`,
    ].filter(Boolean);

    return [head, details.length ? `  ${details.join(" · ")}` : "", event.summary ? `  ${event.summary}` : ""]
        .filter(Boolean)
        .join("\n");
}

function buildPrompt(events: EventSummary[]): string {
    return `Eres analista de inteligencia de fuentes abiertas.
Con esta lista de eventos de las últimas 24 horas, redacta en español un briefing en markdown con:
1. Resumen ejecutivo (máximo 5 líneas).
2. Eventos clave agrupados por categoría, indicando cuántos medios los respaldan.
3. Actores y regiones con más actividad.
4. Qué conviene vigilar en las próximas 24-72 h.
Usa únicamente la información de la lista; no añadas datos externos y señala la incertidumbre cuando haya pocos medios.

EVENTOS:
${events.map(describe).join("\n")}`;
}