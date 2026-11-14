import { HOUR_MS } from "./config";
import { db } from "./db";
import type { Settings } from "./settings";
import type { EventStatus } from "./types";
import { blend, dot, fromBlob, toBlob } from "./vectors";

/** Un evento = varios artículos que cuentan lo mismo. Se identifica por su centroide. */
export interface ActiveEvent {
    id: number;
    centroid: Float32Array;
    articleCount: number;
}

interface EventSeed {
    title: string;
    publishedAt: number;
}

// ---------- Estado (derivado, nunca guardado) ----------

/**
 * - expired: lleva sin noticias más que la ventana de agrupación, así que ya no recibe artículos.
 * - active:  el silencio es normal para el ritmo del propio evento (3× el intervalo medio entre
 *            artículos, con un suelo configurable y sin pasar de la ventana).
 * - cooling: ni una cosa ni la otra: el ritmo se ha frenado, pero aún podría reactivarse.
 */
export function eventStatus(
    event: { first_seen_at: number; last_seen_at: number; article_count: number },
    now: number,
    settings: Pick<Settings, "eventWindowHours" | "eventActiveMinHours">,
): EventStatus {
    const silence = now - event.last_seen_at;
    const windowMs = settings.eventWindowHours * HOUR_MS;
    if (silence > windowMs) return "expired";

    const typicalGap =
        event.article_count > 1 ? (event.last_seen_at - event.first_seen_at) / (event.article_count - 1) : 0;
    const activeLimit = Math.min(windowMs, Math.max(settings.eventActiveMinHours * HOUR_MS, 3 * typicalGap));
    return silence <= activeLimit ? "active" : "cooling";
}

// ---------- Agrupación ----------

export function loadActiveEvents(windowHours: number): ActiveEvent[] {
    const since = Date.now() - windowHours * HOUR_MS;
    return db
        .query<{ id: number; centroid: Uint8Array; article_count: number }, [number]>(
            `SELECT e.id, e.centroid, COUNT(a.id) AS article_count
       FROM events e LEFT JOIN articles a ON a.event_id = e.id
       WHERE e.last_seen_at >= ?
       GROUP BY e.id`,
        )
        .all(since)
        .map((row) => ({
            id: row.id,
            centroid: fromBlob(row.centroid),
            articleCount: Math.max(1, row.article_count),
        }));
}

/** Asigna el artículo al evento más parecido o crea uno nuevo. Devuelve el id del evento. */
export function assignToEvent(
    activeEvents: ActiveEvent[],
    seed: EventSeed,
    embedding: Float32Array,
    minSimilarity: number,
): number {
    const match = findClosest(activeEvents, embedding, minSimilarity);
    return match ? joinEvent(match, seed, embedding) : createEvent(activeEvents, seed, embedding);
}

function findClosest(events: ActiveEvent[], embedding: Float32Array, minSimilarity: number) {
    let closest: ActiveEvent | undefined;
    let bestScore = minSimilarity;
    for (const event of events) {
        const score = dot(event.centroid, embedding);
        if (score >= bestScore) {
            closest = event;
            bestScore = score;
        }
    }
    return closest;
}

function joinEvent(event: ActiveEvent, seed: EventSeed, embedding: Float32Array): number {
    event.centroid = blend(event.centroid, event.articleCount, embedding);
    event.articleCount += 1;
    // MIN en first_seen_at: un feed lento puede traer un artículo anterior al primero que vimos.
    db.query(
        `UPDATE events
     SET centroid = ?,
         first_seen_at = MIN(first_seen_at, ?),
         last_seen_at = MAX(last_seen_at, ?)
     WHERE id = ?`,
    ).run(toBlob(event.centroid), seed.publishedAt, seed.publishedAt, event.id);
    return event.id;
}

function createEvent(activeEvents: ActiveEvent[], seed: EventSeed, embedding: Float32Array): number {
    const { lastInsertRowid } = db
        .query("INSERT INTO events (title, first_seen_at, last_seen_at, centroid) VALUES (?, ?, ?, ?)")
        .run(seed.title, seed.publishedAt, seed.publishedAt, toBlob(embedding));
    const id = Number(lastInsertRowid);
    activeEvents.push({ id, centroid: embedding, articleCount: 1 });
    return id;
}