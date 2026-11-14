import { XMLParser } from "fast-xml-parser";
import { HOUR_MS, MINUTE_MS } from "./config";
import { db } from "./db";
import { getSettings } from "./settings";
import { listSources, markSourceFetched } from "./sources";
import type { RawArticle, Source } from "./types";
import { canonicalUrl, errorMessage, stripHtml } from "./utils";

const GDELT_PAUSE_MS = 5_500; // GDELT permite ~1 petición cada 5 s
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

// fast-xml-parser devuelve estructuras dinámicas (RSS, Atom y RDF difieren)
type XmlNode = Record<string, any>;

export interface IngestSummary {
    sourcesChecked: number;
    articlesAdded: number;
}

// ---------- Orquestación ----------

export async function ingestDueSources(force = false): Promise<IngestSummary> {
    const sources = listSources().filter((source) => source.enabled && (force || isDue(source)));
    let articlesAdded = 0;

    for (const source of sources) {
        articlesAdded += await ingestSource(source);
        if (source.type === "gdelt") await Bun.sleep(GDELT_PAUSE_MS);
    }
    return { sourcesChecked: sources.length, articlesAdded };
}

/** Descarga una fuente y guarda sus artículos nuevos. Nunca lanza: registra el error en la fuente. */
export async function ingestSource(source: Source): Promise<number> {
    const now = Date.now();
    try {
        const added = storeNewArticles(source, await fetchArticles(source));
        markSourceFetched(source.id, now, null, added);
        return added;
    } catch (error) {
        markSourceFetched(source.id, now, errorMessage(error), 0);
        return 0;
    }
}

function isDue(source: Source): boolean {
    if (!source.last_fetched_at) return true;
    return Date.now() - source.last_fetched_at >= source.interval_minutes * MINUTE_MS;
}

function storeNewArticles(source: Source, articles: RawArticle[]): number {
    const now = Date.now();
    const oldestAllowed = now - getSettings().maxArticleAgeHours * HOUR_MS;
    const insert = db.query(
        `INSERT OR IGNORE INTO articles (source_id, title, url, summary, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    );

    let added = 0;
    db.transaction(() => {
        for (const article of articles) {
            if (article.publishedAt < oldestAllowed) continue;
            added += insert.run(
                source.id,
                article.title,
                canonicalUrl(article.url),
                article.summary,
                article.publishedAt,
                now,
            ).changes;
        }
    })();
    return added;
}

// ---------- Descarga y parseo ----------

const fetchArticles = (source: Source): Promise<RawArticle[]> =>
    source.type === "gdelt" ? fetchGdeltArticles(source.url) : fetchRssArticles(source.url);

async function fetchText(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) throw new Error("URL no válida");
    const response = await fetch(url, {
        headers: { "user-agent": "OsintRadar/1.0" },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
}

async function fetchRssArticles(url: string): Promise<RawArticle[]> {
    const feed = xmlParser.parse(await fetchText(url));
    const items = feed.rss?.channel?.item ?? feed["rdf:RDF"]?.item ?? feed.feed?.entry;
    return asArray<XmlNode>(items)
        .map(parseFeedItem)
        .filter((article): article is RawArticle => article !== null);
}

/** Para fuentes GDELT, `url` contiene la consulta (p. ej. `(missile OR drone) sourcelang:english`). */
async function fetchGdeltArticles(query: string): Promise<RawArticle[]> {
    const params = new URLSearchParams({
        query,
        mode: "ArtList",
        format: "json",
        maxrecords: "75",
        timespan: "2h",
        sort: "DateDesc",
    });
    const text = await fetchText(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`);
    const { articles = [] } = JSON.parse(text) as {
        articles?: { title: string; url: string; seendate: string }[];
    };

    return articles.map((article) => ({
        title: stripHtml(article.title),
        url: article.url,
        summary: "",
        publishedAt: parseDate(
            article.seendate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"),
        ),
    }));
}

function parseFeedItem(item: XmlNode): RawArticle | null {
    const title = stripHtml(textOf(item.title));
    const url = extractLink(item);
    if (!title || !url) return null;

    return {
        title,
        url,
        summary: stripHtml(textOf(item.description ?? item.summary ?? item.content)).slice(0, 500),
        publishedAt: parseDate(textOf(item.pubDate ?? item.published ?? item.updated ?? item["dc:date"])),
    };
}

function extractLink(item: XmlNode): string {
    const links = asArray<string | XmlNode>(item.link);
    const preferred =
        links.find((link) => typeof link === "string" || (link["@_rel"] ?? "alternate") === "alternate") ?? links[0];

    if (typeof preferred === "string") return preferred.trim();
    return String(preferred?.["@_href"] || textOf(preferred) || textOf(item.guid)).trim();
}

const asArray = <T>(value: T | T[] | undefined): T[] =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];

function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (node && typeof node === "object" && "#text" in node) return String((node as XmlNode)["#text"]);
    return "";
}

/** Fechas inválidas o futuras se sustituyen por "ahora". */
function parseDate(value: string): number {
    const parsed = Date.parse(value);
    const now = Date.now();
    return Number.isNaN(parsed) ? now : Math.min(parsed, now);
}