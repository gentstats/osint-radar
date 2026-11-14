import { DAY_MS } from "./config";
import { db } from "./db";
import { geminiConfigured } from "./gemini";
import { listCategories } from "./categories";
import type { Category } from "./types";

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
        pending: countPendingArticles(),
        sourcesEnabled: countRows("SELECT COUNT(*) AS n FROM sources WHERE enabled = 1"),
        sourcesFailing: countRows("SELECT COUNT(*) AS n FROM sources WHERE enabled = 1 AND last_error IS NOT NULL"),
        dailyVolume: getDailyVolume(now),
    };
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

export interface EventSummary {
    id: number;
    title: string;
    first_seen_at: number;
    last_seen_at: number;
    article_count: number;
    source_count: number;
    categories: string[];
}

export function getTopEvents(hours: number, limit: number): EventSummary[] {
    const since = Date.now() - hours * 3_600_000;
    const rows = db
        .query<Omit<EventSummary, "categories"> & { categories: string | null }, [number, number]>(
            `SELECT e.id, e.title, e.first_seen_at, e.last_seen_at,
              COUNT(DISTINCT a.id) AS article_count,
              COUNT(DISTINCT a.source_id) AS source_count,
              GROUP_CONCAT(DISTINCT c.name) AS categories
       FROM events e
       JOIN articles a ON a.event_id = e.id
       LEFT JOIN article_categories ac ON ac.article_id = a.id
       LEFT JOIN categories c ON c.id = ac.category_id
       WHERE e.last_seen_at >= ?
       GROUP BY e.id
       ORDER BY source_count DESC, article_count DESC, e.last_seen_at DESC
       LIMIT ?`,
        )
        .all(since, limit);

    return rows.map((row) => ({ ...row, categories: row.categories ? row.categories.split(",") : [] }));
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