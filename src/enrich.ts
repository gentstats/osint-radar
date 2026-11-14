import { z } from "zod";
import { ENRICH_ARTICLES_PER_EVENT, ENRICH_BATCH_SIZE, GEOCODE_MAX_PER_RUN, HOUR_MS } from "./config";
import { db } from "./db";
import {
    EntityResolver,
    geocodePendingEntities,
    replaceEventEntities,
    type EventLink,
    type Mention,
} from "./entities";
import { generateJson, geminiConfigured } from "./gemini";
import { getSettings } from "./settings";
import type { EntityKind } from "./types";
import { chunk, errorMessage, normalizeName, slug } from "./utils";

const MAX_ACTORS = 6;
const MAX_LOCATIONS = 5;

// ---------- Contrato con el LLM ----------

/** Texto tolerante: si falta o no es string, se queda en "" en vez de invalidar todo el lote. */
const text = (max: number) =>
    z
        .string()
        .transform((value) => value.trim().slice(0, max))
        .catch("");

const mentionSchema = z.object({
    name: text(120),
    subtype: text(60),
    country_code: text(10),
    role: text(60),
});

const locationSchema = mentionSchema.extend({
    lat: z.number().min(-90).max(90).optional().catch(undefined),
    lon: z.number().min(-180).max(180).optional().catch(undefined),
});

const extractionSchema = z.object({
    events: z.array(
        z.object({
            id: z.number().int(),
            title: text(200),
            summary: text(1000),
            event_type: text(60),
            actors: z.array(mentionSchema).catch([]),
            locations: z.array(locationSchema).catch([]),
        }),
    ),
});

type ExtractedMention = z.infer<typeof locationSchema>;

const STRING = { type: "STRING" };
const MENTION_PROPERTIES = { name: STRING, subtype: STRING, country_code: STRING, role: STRING };
const MENTION_REQUIRED = ["name", "subtype", "country_code", "role"];

/** Esquema de salida de Gemini (subconjunto de OpenAPI). */
const RESPONSE_SCHEMA = {
    type: "OBJECT",
    properties: {
        events: {
            type: "ARRAY",
            items: {
                type: "OBJECT",
                properties: {
                    id: { type: "INTEGER" },
                    title: STRING,
                    summary: STRING,
                    event_type: STRING,
                    actors: {
                        type: "ARRAY",
                        items: { type: "OBJECT", properties: MENTION_PROPERTIES, required: MENTION_REQUIRED },
                    },
                    locations: {
                        type: "ARRAY",
                        items: {
                            type: "OBJECT",
                            properties: { ...MENTION_PROPERTIES, lat: { type: "NUMBER" }, lon: { type: "NUMBER" } },
                            required: MENTION_REQUIRED,
                        },
                    },
                },
                required: ["id", "title", "summary", "event_type", "actors", "locations"],
            },
        },
    },
    required: ["events"],
};

// ---------- Selección de eventos ----------

interface EventCandidate {
    id: number;
    title: string;
    first_seen_at: number;
    last_seen_at: number;
    article_count: number;
}

/**
 * Eventos vivos con suficientes medios que nunca se han extraído, o cuyo número de artículos
 * se ha duplicado desde la última extracción. Los nuevos van antes que las reextracciones.
 */
function selectCandidates(minSources: number, limit: number, windowHours: number): EventCandidate[] {
    return db
        .query<EventCandidate, [number, number, number]>(
            `SELECT e.id, e.title, e.first_seen_at, e.last_seen_at, COUNT(a.id) AS article_count
       FROM events e JOIN articles a ON a.event_id = e.id
       WHERE e.last_seen_at >= ?
       GROUP BY e.id
       HAVING COUNT(DISTINCT a.source_id) >= ?
          AND (e.extracted_at IS NULL OR COUNT(a.id) >= 2 * e.extracted_articles)
       ORDER BY (e.extracted_at IS NULL) DESC, COUNT(DISTINCT a.source_id) DESC, COUNT(a.id) DESC
       LIMIT ?`,
        )
        .all(Date.now() - windowHours * HOUR_MS, minSources, limit);
}

// ---------- Prompt ----------

function articlesOf(eventId: number) {
    return db
        .query<{ title: string; summary: string; source: string }, [number, number]>(
            `SELECT a.title, a.summary, s.name AS source
       FROM articles a JOIN sources s ON s.id = a.source_id
       WHERE a.event_id = ? ORDER BY a.published_at DESC LIMIT ?`,
        )
        .all(eventId, ENRICH_ARTICLES_PER_EVENT);
}

/** Vocabulario ya generado: se le pasa al modelo para que lo reutilice y la taxonomía sea coherente. */
function knownVocabulary() {
    const types = db
        .query<{ v: string }, []>(
            `SELECT event_type AS v FROM events WHERE event_type IS NOT NULL
       GROUP BY event_type ORDER BY COUNT(*) DESC LIMIT 30`,
        )
        .all()
        .map((row) => row.v);
    const roles = db
        .query<{ v: string }, []>(
            `SELECT ee.role AS v FROM event_entities ee JOIN entities en ON en.id = ee.entity_id
       WHERE en.kind = 'actor' GROUP BY ee.role ORDER BY COUNT(*) DESC LIMIT 25`,
        )
        .all()
        .map((row) => row.v);
    return { types, roles };
}

function buildPrompt(events: EventCandidate[]): string {
    const { types, roles } = knownVocabulary();
    const blocks = events.map((event) => {
        const lines = articlesOf(event.id).map(
            (article) =>
                `- [${article.source}] ${article.title}${article.summary ? `. ${article.summary.slice(0, 200)}` : ""}`,
        );
        return `### id=${event.id}\n${lines.join("\n")}`;
    });

    return `Eres analista de inteligencia de fuentes abiertas. Cada evento de la lista agrupa varios artículos que cuentan lo mismo.
Extrae datos estructurados usando ÚNICAMENTE el texto dado; no añadas información externa ni deduzcas lo que no aparece.

Para cada evento devuelve:
- title: titular neutral y descriptivo en español (máx. 120 caracteres).
- summary: 1-2 frases en español con lo esencial.
- event_type: 1-3 palabras en inglés, minúsculas y con guion bajo (p. ej. airstrike, sanctions, cyberattack).
  Tipos ya usados: ${types.join(", ") || "(ninguno todavía)"}. Reutiliza uno si encaja; si no, propón uno nuevo.
- actors: protagonistas (estados, gobiernos, organizaciones, grupos armados, empresas, personas), por relevancia, máximo ${MAX_ACTORS}.
  name: nombre canónico en inglés, sin artículo (p. ej. "Hezbollah", "European Union", "United States").
  subtype: tipo en inglés (country, government, armed_group, organization, company, person...).
  country_code: ISO 3166-1 alfa-2 del país asociado, o "" si no aplica.
  role: papel en el evento (aggressor, target, victim, mediator, participant...). Roles ya usados: ${roles.join(", ") || "(ninguno todavía)"}.
- locations: lugares donde ocurre (role "occurred") o implicados (role "involved"), por relevancia, máximo ${MAX_LOCATIONS}.
  name: nombre canónico en inglés del lugar más específico que permita el texto (ciudad, región, estrecho, mar...).
  subtype: country, region, city, sea, strait, facility...
  country_code: ISO alfa-2 del país donde está, o "" si es un mar o abarca varios países.
  lat y lon: solo si conoces las coordenadas aproximadas con seguridad; si no, omítelos.
- Si no hay actores o lugares claros, devuelve la lista vacía.
- Devuelve exactamente un elemento por evento, con el mismo id.

EVENTOS:
${blocks.join("\n\n")}`;
}

// ---------- Aplicación del resultado ----------

interface Planned {
    eventId: number;
    mention: Mention;
    role: string;
    weight: number;
}

const cleanCountry = (value: string): string => (/^[A-Za-z]{2}$/.test(value) ? value.toUpperCase() : "");

function toPlanned(
    event: EventCandidate,
    kind: EntityKind,
    items: ExtractedMention[],
    max: number,
    roleOf: (item: ExtractedMention) => string,
): Planned[] {
    return items
        .filter((item) => normalizeName(item.name) !== "")
        .slice(0, max)
        .map((item, index) => {
            // (0, 0) es el valor típico de un modelo que no sabe: se descarta.
            const hasCoords =
                item.lat !== undefined && item.lon !== undefined && !(item.lat === 0 && item.lon === 0);
            return {
                eventId: event.id,
                mention: {
                    kind,
                    name: item.name,
                    subtype: slug(item.subtype),
                    countryCode: cleanCountry(item.country_code),
                    lat: hasCoords ? item.lat : undefined,
                    lon: hasCoords ? item.lon : undefined,
                    seenAt: event.first_seen_at,
                },
                role: roleOf(item),
                // El modelo ordena por relevancia: el peso decae con la posición.
                weight: Math.max(0.3, 1 - 0.15 * index),
            };
        });
}

async function enrichBatch(batch: EventCandidate[], resolver: EntityResolver): Promise<number> {
    const extraction = await generateJson(buildPrompt(batch), RESPONSE_SCHEMA, (raw) =>
        extractionSchema.parse(raw),
    );

    const byId = new Map(batch.map((event) => [event.id, event]));
    const items = extraction.events.filter((item) => byId.has(item.id));

    const planned = items.flatMap((item) => {
        const event = byId.get(item.id)!;
        return [
            ...toPlanned(event, "actor", item.actors, MAX_ACTORS, (m) => slug(m.role) || "participant"),
            ...toPlanned(event, "location", item.locations, MAX_LOCATIONS, (m) =>
                slug(m.role) === "occurred" ? "occurred" : "involved",
            ),
        ];
    });

    const entityIds = await resolver.resolve(planned.map((p) => p.mention));

    const linksByEvent = new Map<number, EventLink[]>();
    planned.forEach((p, i) => {
        const links = linksByEvent.get(p.eventId) ?? [];
        links.push({ entityId: entityIds[i], role: p.role, weight: p.weight });
        linksByEvent.set(p.eventId, links);
    });

    const update = db.query(
        `UPDATE events
     SET title = ?, summary = ?, event_type = ?, extracted_at = ?, extracted_articles = ?
     WHERE id = ?`,
    );
    db.transaction(() => {
        for (const item of items) {
            const event = byId.get(item.id)!;
            update.run(
                item.title || event.title,
                item.summary || null,
                slug(item.event_type) || null,
                Date.now(),
                event.article_count,
                event.id,
            );
            replaceEventEntities(event.id, event.last_seen_at, linksByEvent.get(event.id) ?? []);
        }
    })();
    return items.length;
}

// ---------- Punto de entrada ----------

export interface EnrichSummary {
    enriched: number;
    located: number;
    skipped?: string;
    error?: string;
}

let busy = false;

/** Extrae resumen, tipo, actores y lugares de los eventos que lo necesiten y geocodifica los lugares nuevos. */
export async function enrichEvents(): Promise<EnrichSummary> {
    const settings = getSettings();
    if (!geminiConfigured()) return { enriched: 0, located: 0, skipped: "GEMINI_API_KEY no configurada" };
    if (!settings.enrichEnabled) return { enriched: 0, located: 0, skipped: "Enriquecimiento desactivado" };
    if (busy) return { enriched: 0, located: 0, skipped: "Ya hay un enriquecimiento en marcha" };

    busy = true;
    const summary: EnrichSummary = { enriched: 0, located: 0 };
    try {
        try {
            const candidates = selectCandidates(
                settings.enrichMinSources,
                settings.enrichMaxEventsPerRun,
                settings.eventWindowHours,
            );
            const resolver = new EntityResolver(settings.entityMergeSimilarity);
            for (const batch of chunk(candidates, ENRICH_BATCH_SIZE)) {
                summary.enriched += await enrichBatch(batch, resolver);
            }
        } catch (error) {
            // Cuota, JSON roto, red... Los eventos sin procesar se reintentan en el siguiente ciclo.
            summary.error = errorMessage(error);
            console.error("[enrich]", summary.error);
        }

        if (settings.geocodingEnabled) summary.located = await geocodePendingEntities(GEOCODE_MAX_PER_RUN);
    } finally {
        busy = false;
    }
    return summary;
}