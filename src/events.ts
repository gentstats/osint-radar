import { HOUR_MS } from "./config";
import { db } from "./db";
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
    db.query("UPDATE events SET centroid = ?, last_seen_at = MAX(last_seen_at, ?) WHERE id = ?").run(
        toBlob(event.centroid),
        seed.publishedAt,
        event.id,
    );
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