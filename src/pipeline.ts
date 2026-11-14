import { DAY_MS } from "./config";
import { db } from "./db";
import {
    classify,
    ensureCategoryVectors,
    loadPrototypes,
    saveClassification,
    type CategoryPrototype,
} from "./categories";
import { enrichEvents } from "./enrich";
import { assignToEvent, loadActiveEvents, type ActiveEvent } from "./events";
import { embedTexts, geminiConfigured } from "./gemini";
import { ingestDueSources } from "./ingest";
import { countPendingArticles } from "./queries";
import { recordRun } from "./runs";
import { getSettings } from "./settings";
import { chunk, errorMessage } from "./utils";
import { fromBlob, toBlob } from "./vectors";

const MAX_PER_RUN = 300;
const EMBEDDING_CHUNK = 50;

interface PendingArticle {
    id: number;
    title: string;
    summary: string;
    published_at: number;
}

interface ProcessingContext {
    prototypes: CategoryPrototype[];
    events: ActiveEvent[];
    eventSimilarity: number;
}

let running = false;

/**
 * Un ciclo completo:
 * descargar fuentes → limpiar datos antiguos → procesar artículos → enriquecer eventos (actores y lugares).
 */
export async function runPipeline({ force = false } = {}) {
    if (running) return { skipped: true };
    running = true;
    const startedAt = Date.now();

    try {
        const ingest = await ingestDueSources(force);
        pruneOldData();
        const processing = await processPendingArticles();
        const enrichment = await enrichEvents(); // nunca lanza: sus errores quedan en el resumen

        const summary = { ingest, processing, enrichment };
        const didWork = ingest.sourcesChecked > 0 || processing.processed > 0 || enrichment.enriched > 0;
        if (didWork) recordRun("pipeline", startedAt, true, summary);
        return summary;
    } catch (error) {
        recordRun("pipeline", startedAt, false, { error: errorMessage(error) });
        throw error;
    } finally {
        running = false;
    }
}

export async function processPendingArticles() {
    if (!geminiConfigured()) {
        return { processed: 0, remaining: countPendingArticles(), skipped: "GEMINI_API_KEY no configurada" };
    }

    await ensureCategoryVectors();

    const pending = db
        .query<PendingArticle, [number]>(
            `SELECT id, title, summary, published_at FROM articles
       WHERE status = 'pending' ORDER BY published_at ASC LIMIT ?`,
        )
        .all(MAX_PER_RUN);

    const settings = getSettings();
    const context: ProcessingContext = {
        prototypes: loadPrototypes(),
        events: loadActiveEvents(settings.eventWindowHours),
        eventSimilarity: settings.eventSimilarity,
    };

    let processed = 0;
    for (const batch of chunk(pending, EMBEDDING_CHUNK)) {
        const embeddings = await embedTexts(batch.map(articleText));
        db.transaction(() => {
            batch.forEach((article, i) => saveProcessedArticle(article, embeddings[i], context));
        })();
        processed += batch.length;
    }

    return { processed, remaining: countPendingArticles() };
}

const articleText = (article: PendingArticle): string => `${article.title}. ${article.summary}`.slice(0, 600);

function saveProcessedArticle(article: PendingArticle, embedding: Float32Array, context: ProcessingContext): void {
    const eventId = assignToEvent(
        context.events,
        { title: article.title, publishedAt: article.published_at },
        embedding,
        context.eventSimilarity,
    );
    db.query("UPDATE articles SET embedding = ?, event_id = ?, status = 'processed' WHERE id = ?").run(
        toBlob(embedding),
        eventId,
        article.id,
    );
    saveClassification(article.id, classify(embedding, context.prototypes));
}

// ---------- Mantenimiento ----------

/** Vuelve a clasificar con los embeddings guardados (sin llamadas a la API). */
export async function reclassifyStoredArticles() {
    await ensureCategoryVectors();
    const prototypes = loadPrototypes();
    const rows = db
        .query<{ id: number; embedding: Uint8Array }, []>("SELECT id, embedding FROM articles WHERE embedding IS NOT NULL")
        .all();

    db.transaction(() => {
        db.exec("DELETE FROM article_categories");
        for (const row of rows) saveClassification(row.id, classify(fromBlob(row.embedding), prototypes));
    })();
    return { reclassified: rows.length };
}

/**
 * Descarta embeddings, eventos, entidades y clasificaciones: el siguiente ciclo lo recalcula todo.
 * Las entidades también se borran porque sus vectores dejan de ser comparables si cambia el modelo.
 */
export function resetForReembedding(): void {
    db.transaction(() => {
        db.exec("DELETE FROM article_categories");
        db.exec("DELETE FROM category_vectors");
        db.exec("UPDATE articles SET embedding = NULL, event_id = NULL, status = 'pending'");
        db.exec("DELETE FROM events"); // arrastra event_entities
        db.exec("DELETE FROM entities"); // arrastra entity_aliases
    })();
}

function pruneOldData(): void {
    const settings = getSettings();
    const cutoff = Date.now() - settings.retentionDays * DAY_MS;
    db.query("DELETE FROM articles WHERE published_at < ?").run(cutoff);
    db.query("DELETE FROM events WHERE last_seen_at < ?").run(cutoff); // arrastra event_entities
    db.query("DELETE FROM runs WHERE started_at < ?").run(cutoff);

    // Las entidades viven más que los eventos: solo se borran las huérfanas y antiguas.
    db.query(
        `DELETE FROM entities
     WHERE last_seen_at < ?
       AND NOT EXISTS (SELECT 1 FROM event_entities ee WHERE ee.entity_id = entities.id)`,
    ).run(Date.now() - settings.entityRetentionDays * DAY_MS);
}