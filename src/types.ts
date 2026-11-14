export interface Source {
    id: number;
    name: string;
    type: "rss" | "gdelt";
    url: string;
    enabled: number;
    interval_minutes: number;
    last_fetched_at: number | null;
    last_error: string | null;
    articles_total: number;
}

export interface Category {
    id: number;
    name: string;
    description: string;
    examples: string;
    threshold: number;
    enabled: number;
}

export interface RawArticle {
    title: string;
    url: string;
    summary: string;
    publishedAt: number;
}

export type EntityKind = "actor" | "location";

/** Se calcula al consultar, nunca se guarda: así no queda obsoleto. */
export type EventStatus = "active" | "cooling" | "expired";

export interface Entity {
    id: number;
    kind: EntityKind;
    subtype: string | null;
    name: string;
    country_code: string | null;
    lat: number | null;
    lon: number | null;
    /** 'geocoder' = coordenadas fiables; 'llm' = aproximación del modelo. */
    geo_source: "geocoder" | "llm" | null;
    first_seen_at: number;
    last_seen_at: number;
}