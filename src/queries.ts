import { DAY_MS, HOUR_MS } from "./config";
import { db } from "./db";
import { geminiConfigured } from "./gemini";
import { listCategories } from "./categories";
import { eventStatus } from "./events";
import { getSettings } from "./settings";
import type { Category, Entity, EntityKind, EventStatus } from "./types";
import { normalizeName } from "./utils";

const DAYS_TRACKED = 7;
const ANOMALY_Z_SCORE = 2;
const ANOMALY_MIN_ARTICLES = 6;

const countRows = (sql: string, ...params: number[]): number =>
    db.query<{ n: number }, number[]>(sql).get(...params)!.n;

export const countPendingArticles = (): number =>
    countRows("SELECT COUNT(*) AS n FROM articles WHERE status = 'pending'");

// ---------- Resumen ----------

export function getOverview() {
    const now = Date.now();
    const since = now - DAY_MS;

    return {
        geminiConfigured: geminiConfigured(),
        articlesTotal: countRows("SELECT COUNT(*) AS n FROM articles"),
        articles24h: countRows("SELECT COUNT(*) AS n FROM articles WHERE published_at >= ?", since),
        unclassified24h: countRows(
            `SELECT COUNT(*) AS n FROM articles a
       WHERE a.status = 'processed' AND a.published_at >= ?
         AND NOT EXISTS (SELECT 1 FROM article_categories x WHERE x.article_id = a.id)`,
            since,
        ),
        events24h: countRows("SELECT COUNT(*) AS n FROM events WHERE last_seen_at >= ?", since),
        eventsActive: countActiveEvents(now),
        eventsEnriched24h: countRows(
            "SELECT COUNT(*) AS n FROM events WHERE last_seen_at >= ? AND extracted_at IS NOT NULL",
            since,
        ),
        entitiesTotal: countRows("SELECT COUNT(*) AS n FROM entities"),
        locationsLocated: countRows("SELECT COUNT(*) AS n FROM entities WHERE kind = 'location' AND lat IS NOT NULL"),
        pending: countPendingArticles(),
        sourcesEnabled: countRows("SELECT COUNT(*) AS n FROM sources WHERE enabled = 1"),
        sourcesFailing: countRows("SELECT COUNT(*) AS n FROM sources WHERE enabled = 1 AND last_error IS NOT NULL"),
        dailyVolume: getDailyVolume(now),
    };
}

function countActiveEvents(now: number): number {
    const settings = getSettings();
    return db
        .query<{ first_seen_at: number; last_seen_at: number; article_count: number }, [number]>(
            `SELECT e.first_seen_at, e.last_seen_at, COUNT(a.id) AS article_count
       FROM events e JOIN articles a ON a.event_id = e.id
       WHERE e.last_seen_at >= ?
       GROUP BY e.id`,
        )
        .all(now - settings.eventWindowHours * HOUR_MS)
        .filter((row) => eventStatus(row, now, settings) === "active").length;
}

/** Artículos por ventana de 24 h. Índice 0 = últimas 24 h, 1 = las 24 h anteriores, etc. */
function getDailyVolume(now: number): number[] {
    const rows = db
        .query<{ day: number; n: number }, [number, number]>(
            `SELECT CAST((? - published_at) / ${DAY_MS} AS INTEGER) AS day, COUNT(*) AS n
       FROM articles WHERE published_at >= ? GROUP BY day`,
        )
        .all(now, now - DAYS_TRACKED * DAY_MS);

    const volume = new Array<number>(DAYS_TRACKED).fill(0);
    for (const { day, n } of rows) {
        if (day >= 0 && day < DAYS_TRACKED) volume[day] = n;
    }
    return volume;
}

// ---------- Tendencias y anomalías ----------

export interface CategoryTrend {
    id: number;
    name: string;
    today: number;
    baseline: number | null;
    zScore: number | null;
    anomaly: boolean;
    daily: number[];
}

export function getCategoryTrends(): CategoryTrend[] {
    const now = Date.now();
    const rows = db
        .query<{ category_id: number; day: number; n: number }, [number, number]>(
            `SELECT ac.category_id, CAST((? - a.published_at) / ${DAY_MS} AS INTEGER) AS day, COUNT(*) AS n
       FROM article_categories ac JOIN articles a ON a.id = ac.article_id
       WHERE a.published_at >= ? GROUP BY ac.category_id, day`,
        )
        .all(now, now - DAYS_TRACKED * DAY_MS);

    const dailyByCategory = new Map<number, number[]>();
    for (const { category_id, day, n } of rows) {
        if (day < 0 || day >= DAYS_TRACKED) continue;
        const daily = dailyByCategory.get(category_id) ?? new Array<number>(DAYS_TRACKED).fill(0);
        daily[day] = n;
        dailyByCategory.set(category_id, daily);
    }

    const baselineDays = getCollectionDays(now);
    return listCategories()
        .filter((category) => category.enabled)
        .map((category) =>
            buildTrend(category, dailyByCategory.get(category.id) ?? new Array(DAYS_TRACKED).fill(0), baselineDays),
        );
}

/** Días completos de histórico disponibles para calcular la línea base. */
function getCollectionDays(now: number): number {
    const first = db.query<{ first: number | null }, []>("SELECT MIN(fetched_at) AS first FROM articles").get()?.first;
    return first ? Math.min(DAYS_TRACKED - 1, Math.floor((now - first) / DAY_MS)) : 0;
}

function buildTrend(category: Category, daily: number[], baselineDays: number): CategoryTrend {
    const today = daily[0];
    const hasBaseline = baselineDays >= 2;
    const baseline = hasBaseline
        ? daily.slice(1, 1 + baselineDays).reduce((sum, n) => sum + n, 0) / baselineDays
        : null;
    const zScore = baseline === null ? null : (today - baseline) / Math.sqrt(baseline + 4);

    return {
        id: category.id,
        name: category.name,
        today,
        baseline,
        zScore,
        anomaly: zScore !== null && zScore >= ANOMALY_Z_SCORE && today >= ANOMALY_MIN_ARTICLES,
        daily,
    };
}

// ---------- Eventos ----------

export interface EventEntityRef {
    id: number;
    kind: EntityKind;
    name: string;
    subtype: string | null;
    country_code: string | null;
    lat: number | null;
    lon: number | null;
    role: string;
    weight: number;
}

export interface EventSummary {
    id: number;
    title: string;
    summary: string | null;
    event_type: string | null;
    first_seen_at: number;
    last_seen_at: number;
    article_count: number;
    source_count: number;
    categories: string[];
    status: EventStatus;
    enriched: boolean;
    actors: EventEntityRef[];
    locations: EventEntityRef[];
}

export interface EventFilter {
    hours: number;
    limit: number;
    status?: EventStatus;
    entityId?: number;
    eventType?: string;
}

interface EventRow {
    id: number;
    title: string;
    summary: string | null;
    event_type: string | null;
    extracted_at: number | null;
    first_seen_at: number;
    last_seen_at: number;
    article_count: number;
    source_count: number;
    categories: string | null;
}

export function getTopEvents(filter: EventFilter): EventSummary[] {
    const conditions = ["e.last_seen_at >= ?"];
    const params: (string | number)[] = [Date.now() - filter.hours * HOUR_MS];

    if (filter.entityId) {
        conditions.push("EXISTS (SELECT 1 FROM event_entities x WHERE x.event_id = e.id AND x.entity_id = ?)");
        params.push(filter.entityId);
    }
    if (filter.eventType) {
        conditions.push("e.event_type = ?");
        params.push(filter.eventType);
    }
    return loadEvents(conditions, params, filter.limit, filter.status);
}

export function getEventDetail(id: number) {
    const [event] = loadEvents(["e.id = ?"], [id], 1);
    return event ? { event, articles: getEventArticles(id) } : null;
}

/** El estado se calcula en TypeScript, así que con filtro de estado se trae un margen y se recorta después. */
function loadEvents(
    conditions: string[],
    params: (string | number)[],
    limit: number,
    status?: EventStatus,
): EventSummary[] {
    const now = Date.now();
    const settings = getSettings();

    const rows = db
        .query<EventRow, (string | number)[]>(
            `SELECT e.id, e.title, e.summary, e.event_type, e.extracted_at, e.first_seen_at, e.last_seen_at,
              COUNT(DISTINCT a.id) AS article_count,
              COUNT(DISTINCT a.source_id) AS source_count,
              GROUP_CONCAT(DISTINCT c.name) AS categories
       FROM events e
       JOIN articles a ON a.event_id = e.id
       LEFT JOIN article_categories ac ON ac.article_id = a.id
       LEFT JOIN categories c ON c.id = ac.category_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY e.id
       ORDER BY source_count DESC, article_count DESC, e.last_seen_at DESC
       LIMIT ?`,
        )
        .all(...params, status ? 5000 : limit);

    const events = rows
        .map(({ extracted_at, categories, ...row }) => ({
            ...row,
            categories: categories ? categories.split(",") : [],
            status: eventStatus(row, now, settings),
            enriched: extracted_at !== null,
        }))
        .filter((event) => !status || event.status === status)
        .slice(0, limit);

    const entities = loadEventEntities(events.map((event) => event.id));
    return events.map((event) => {
        const refs = entities.get(event.id) ?? [];
        return {
            ...event,
            actors: refs.filter((ref) => ref.kind === "actor"),
            locations: refs.filter((ref) => ref.kind === "location"),
        };
    });
}

function loadEventEntities(eventIds: number[]): Map<number, EventEntityRef[]> {
    const byEvent = new Map<number, EventEntityRef[]>();
    if (eventIds.length === 0) return byEvent;

    const placeholders = eventIds.map(() => "?").join(", ");
    const rows = db
        .query<EventEntityRef & { event_id: number }, number[]>(
            `SELECT ee.event_id, en.id, en.kind, en.name, en.subtype, en.country_code, en.lat, en.lon,
              ee.role, ee.weight
       FROM event_entities ee JOIN entities en ON en.id = ee.entity_id
       WHERE ee.event_id IN (${placeholders})
       ORDER BY ee.weight DESC`,
        )
        .all(...eventIds);

    for (const { event_id, ...ref } of rows) {
        const list = byEvent.get(event_id) ?? [];
        list.push(ref);
        byEvent.set(event_id, list);
    }
    return byEvent;
}

export function getEventArticles(eventId: number) {
    return db
        .query<{ id: number; title: string; url: string; published_at: number; source: string }, [number]>(
            `SELECT a.id, a.title, a.url, a.published_at, s.name AS source
       FROM articles a JOIN sources s ON s.id = a.source_id
       WHERE a.event_id = ? ORDER BY a.published_at`,
        )
        .all(eventId);
}

/** Tipos de evento que han ido apareciendo (vocabulario emergente). */
export const listEventTypes = () =>
    db
        .query<{ event_type: string; n: number }, []>(
            `SELECT event_type, COUNT(*) AS n FROM events
       WHERE event_type IS NOT NULL GROUP BY event_type ORDER BY n DESC LIMIT 60`,
        )
        .all();

// ---------- Entidades ----------

export interface EntityFilter {
    kind?: EntityKind;
    /** 0 = sin límite de tiempo. */
    hours: number;
    limit: number;
    search?: string;
}

export interface EntityListItem extends Entity {
    recent_events: number;
    total_events: number;
}

export function listEntities(filter: EntityFilter): EntityListItem[] {
    const since = Date.now() - filter.hours * HOUR_MS;
    const conditions = ["1 = 1"];
    const params: (string | number)[] = [since];

    if (filter.kind) {
        conditions.push("en.kind = ?");
        params.push(filter.kind);
    }
    if (filter.search) {
        conditions.push(
            "(en.name LIKE ? OR EXISTS (SELECT 1 FROM entity_aliases al WHERE al.entity_id = en.id AND al.alias LIKE ?))",
        );
        params.push(`%${filter.search}%`, `%${normalizeName(filter.search)}%`);
    }

    return db
        .query<EntityListItem, (string | number)[]>(
            `SELECT en.id, en.kind, en.subtype, en.name, en.country_code, en.lat, en.lon, en.geo_source,
              en.first_seen_at, en.last_seen_at,
              COUNT(DISTINCT CASE WHEN e.last_seen_at >= ? THEN e.id END) AS recent_events,
              COUNT(DISTINCT e.id) AS total_events
       FROM entities en
       LEFT JOIN event_entities ee ON ee.entity_id = en.id
       LEFT JOIN events e ON e.id = ee.event_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY en.id
       ${filter.hours > 0 ? "HAVING recent_events > 0" : ""}
       ORDER BY recent_events DESC, total_events DESC, en.last_seen_at DESC
       LIMIT ?`,
        )
        .all(...params, filter.limit);
}

export function getEntityDetail(id: number) {
    const entity = db
        .query<Entity, [number]>(
            `SELECT id, kind, subtype, name, country_code, lat, lon, geo_source, first_seen_at, last_seen_at
       FROM entities WHERE id = ?`,
        )
        .get(id);
    if (!entity) return null;

    const aliases = db
        .query<{ alias: string }, [number]>("SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias")
        .all(id)
        .map((row) => row.alias);

    // Coocurrencias: con qué otras entidades comparte eventos.
    const related = db
        .query<{ id: number; kind: EntityKind; subtype: string | null; name: string; shared: number }, [number]>(
            `SELECT en.id, en.kind, en.subtype, en.name, COUNT(DISTINCT ee2.event_id) AS shared
       FROM event_entities ee1
       JOIN event_entities ee2 ON ee2.event_id = ee1.event_id AND ee2.entity_id != ee1.entity_id
       JOIN entities en ON en.id = ee2.entity_id
       WHERE ee1.entity_id = ?
       GROUP BY en.id
       ORDER BY shared DESC
       LIMIT 15`,
        )
        .all(id);

    return { entity, aliases, related };
}

// ---------- Artículos ----------

export interface ArticleFilter {
    limit: number;
    offset: number;
    categoryId?: number;
    sourceId?: number;
    search?: string;
}

export function listArticles(filter: ArticleFilter) {
    const conditions = ["1 = 1"];
    const params: (string | number)[] = [];

    if (filter.sourceId) {
        conditions.push("a.source_id = ?");
        params.push(filter.sourceId);
    }
    if (filter.categoryId) {
        conditions.push(
            "EXISTS (SELECT 1 FROM article_categories x WHERE x.article_id = a.id AND x.category_id = ?)",
        );
        params.push(filter.categoryId);
    }
    if (filter.search) {
        conditions.push("a.title LIKE ?");
        params.push(`%${filter.search}%`);
    }

    const rows = db
        .query<
            { id: number; title: string; url: string; published_at: number; status: string; source: string; event_id: number | null; categories: string },
            (string | number)[]
        >(
            `SELECT a.id, a.title, a.url, a.published_at, a.status, a.event_id, s.name AS source,
              json_group_array(json_object('name', c.name, 'score', ac.score))
                FILTER (WHERE c.id IS NOT NULL) AS categories
       FROM articles a
       JOIN sources s ON s.id = a.source_id
       LEFT JOIN article_categories ac ON ac.article_id = a.id
       LEFT JOIN categories c ON c.id = ac.category_id
       WHERE ${conditions.join(" AND ")}
       GROUP BY a.id
       ORDER BY a.published_at DESC
       LIMIT ? OFFSET ?`,
        )
        .all(...params, filter.limit, filter.offset);

    return rows.map(({ categories, ...row }) => ({
        ...row,
        categories: (JSON.parse(categories ?? "[]") as { name: string; score: number }[]).sort(
            (a, b) => b.score - a.score,
        ),
    }));
}