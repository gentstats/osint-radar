import { db } from "./db";
import { embedTexts } from "./gemini";
import { geocode, type GeoResult } from "./geocode";
import type { EntityKind } from "./types";
import { errorMessage, normalizeName } from "./utils";
import { dot, fromBlob, toBlob } from "./vectors";

/** Una mención tal y como la devuelve el extractor, ya normalizada. */
export interface Mention {
    kind: EntityKind;
    name: string;
    /** "" si se desconoce. */
    subtype: string;
    /** ISO alfa-2 o "" si se desconoce. */
    countryCode: string;
    /** Coordenadas aproximadas del LLM: solo se usan si el geocoder no encuentra el lugar. */
    lat?: number;
    lon?: number;
    /** Cuándo salió la primera noticia del evento donde aparece. */
    seenAt: number;
}

export interface EventLink {
    entityId: number;
    role: string;
    weight: number;
}

interface Candidate {
    id: number;
    countryCode: string | null;
    vector: Float32Array;
}

/**
 * Los lugares homónimos (Georgia país / Georgia estado) se distinguen por país.
 * Con los actores no se aplica: su país es una pista poco estable entre noticias.
 */
const sameCountry = (mention: Mention, other: string | null): boolean =>
    mention.kind !== "location" || !mention.countryCode || !other || mention.countryCode === other;

const embeddingText = (mention: Mention): string =>
    `${mention.name} (${[mention.subtype, mention.countryCode].filter(Boolean).join(", ") || mention.kind})`;

/**
 * Convierte menciones en ids de entidad, creando las que no existan:
 *   1. alias exacto (normalizado)  →  2. similitud de embeddings  →  3. entidad nueva.
 * Se crea una instancia por ciclo: cachea los vectores para no releerlos de la base de datos.
 */
export class EntityResolver {
    private readonly candidates = new Map<EntityKind, Candidate[]>();

    constructor(private readonly minSimilarity: number) { }

    async resolve(mentions: Mention[]): Promise<number[]> {
        const ids = new Array<number>(mentions.length);
        const pending: number[] = [];

        mentions.forEach((mention, i) => {
            const id = this.findByAlias(mention);
            if (id === null) {
                pending.push(i);
            } else {
                ids[i] = id;
                this.refine(id, mention);
            }
        });
        if (pending.length === 0) return ids;

        const vectors = await embedTexts(pending.map((i) => embeddingText(mentions[i])));
        pending.forEach((i, n) => {
            const mention = mentions[i];
            // El alias se vuelve a mirar: otra mención del mismo lote pudo crearlo hace un momento.
            const id = this.findByAlias(mention) ?? this.findBySimilarity(mention, vectors[n]);
            if (id !== null) {
                this.addAlias(id, mention);
                this.refine(id, mention);
                ids[i] = id;
            } else {
                ids[i] = this.create(mention, vectors[n]);
            }
        });
        return ids;
    }

    private findByAlias(mention: Mention): number | null {
        const alias = normalizeName(mention.name);
        if (!alias) return null;
        const rows = db
            .query<{ id: number; country_code: string | null }, [string, string]>(
                `SELECT en.id, en.country_code
         FROM entity_aliases al JOIN entities en ON en.id = al.entity_id
         WHERE al.kind = ? AND al.alias = ?`,
            )
            .all(mention.kind, alias);
        return rows.find((row) => sameCountry(mention, row.country_code))?.id ?? null;
    }

    private findBySimilarity(mention: Mention, vector: Float32Array): number | null {
        let best: number | null = null;
        let bestScore = this.minSimilarity;
        for (const candidate of this.load(mention.kind)) {
            if (!sameCountry(mention, candidate.countryCode)) continue;
            const score = dot(candidate.vector, vector);
            if (score >= bestScore) {
                best = candidate.id;
                bestScore = score;
            }
        }
        return best;
    }

    private load(kind: EntityKind): Candidate[] {
        let list = this.candidates.get(kind);
        if (!list) {
            list = db
                .query<{ id: number; country_code: string | null; embedding: Uint8Array }, [string]>(
                    "SELECT id, country_code, embedding FROM entities WHERE kind = ? AND embedding IS NOT NULL",
                )
                .all(kind)
                .map((row) => ({ id: row.id, countryCode: row.country_code, vector: fromBlob(row.embedding) }));
            this.candidates.set(kind, list);
        }
        return list;
    }

    private create(mention: Mention, vector: Float32Array): number {
        const list = this.load(mention.kind); // antes del INSERT, para no duplicar la entidad nueva
        const hasCoords = mention.lat !== undefined && mention.lon !== undefined;

        const { lastInsertRowid } = db
            .query(
                `INSERT INTO entities
           (kind, subtype, name, country_code, embedding, lat, lon, geo_source, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                mention.kind,
                mention.subtype || null,
                mention.name,
                mention.countryCode || null,
                toBlob(vector),
                hasCoords ? mention.lat! : null,
                hasCoords ? mention.lon! : null,
                hasCoords ? "llm" : null,
                mention.seenAt,
                mention.seenAt,
            );

        const id = Number(lastInsertRowid);
        this.addAlias(id, mention);
        list.push({ id, countryCode: mention.countryCode || null, vector });
        return id;
    }

    private addAlias(id: number, mention: Mention): void {
        const alias = normalizeName(mention.name);
        if (!alias) return;
        db.query("INSERT OR IGNORE INTO entity_aliases (entity_id, kind, alias) VALUES (?, ?, ?)").run(
            id,
            mention.kind,
            alias,
        );
    }

    /** Rellena los datos que faltaban y adelanta `first_seen_at` si esta mención es más antigua. */
    private refine(id: number, mention: Mention): void {
        db.query(
            `UPDATE entities
       SET subtype = COALESCE(subtype, ?),
           country_code = COALESCE(country_code, ?),
           first_seen_at = MIN(first_seen_at, ?)
       WHERE id = ?`,
        ).run(mention.subtype || null, mention.countryCode || null, mention.seenAt, id);

        if (mention.lat !== undefined && mention.lon !== undefined) {
            db.query("UPDATE entities SET lat = ?, lon = ?, geo_source = 'llm' WHERE id = ? AND lat IS NULL").run(
                mention.lat,
                mention.lon,
                id,
            );
        }
    }
}

/** Sustituye las entidades de un evento por las de la última extracción. */
export function replaceEventEntities(eventId: number, lastSeenAt: number, links: EventLink[]): void {
    db.query("DELETE FROM event_entities WHERE event_id = ?").run(eventId);
    const insert = db.query(
        "INSERT OR IGNORE INTO event_entities (event_id, entity_id, role, weight) VALUES (?, ?, ?, ?)",
    );
    const touch = db.query("UPDATE entities SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?");
    for (const link of links) {
        insert.run(eventId, link.entityId, link.role, link.weight);
        touch.run(lastSeenAt, link.entityId);
    }
}

/** Geocodifica los lugares que aún no se han intentado. Cada lugar se consulta una sola vez. */
export async function geocodePendingEntities(limit: number): Promise<number> {
    const rows = db
        .query<{ id: number; name: string; country_code: string | null }, [number]>(
            `SELECT id, name, country_code FROM entities
       WHERE kind = 'location' AND geo_checked_at IS NULL
       ORDER BY last_seen_at DESC LIMIT ?`,
        )
        .all(limit);

    let located = 0;
    for (const row of rows) {
        let result: GeoResult | null;
        try {
            result = await geocode(row.name, row.country_code);
        } catch (error) {
            console.warn("[geocode]", errorMessage(error));
            break; // sin red o bloqueado: se reintenta en el próximo ciclo
        }

        if (result) {
            db.query(
                `UPDATE entities
         SET lat = ?, lon = ?, geo_source = 'geocoder',
             country_code = COALESCE(country_code, ?), geo_checked_at = ?
         WHERE id = ?`,
            ).run(result.lat, result.lon, result.countryCode, Date.now(), row.id);
            located++;
        } else {
            // Si el LLM dio coordenadas aproximadas, se quedan con geo_source = 'llm'.
            db.query("UPDATE entities SET geo_checked_at = ? WHERE id = ?").run(Date.now(), row.id);
        }
    }
    return located;
}