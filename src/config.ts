export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Dimensiones del vector. Si lo cambias, usa "Reindexar todo" en el dashboard. */
export const EMBEDDING_DIMENSIONS = 768;

/** Eventos por llamada al LLM de extracción (cuida la cuota gratuita). */
export const ENRICH_BATCH_SIZE = 8;
/** Artículos de cada evento que se envían al LLM. */
export const ENRICH_ARTICLES_PER_EVENT = 8;
/** Lugares nuevos que se geocodifican como máximo por ciclo. */
export const GEOCODE_MAX_PER_RUN = 15;

export const env = {
    port: Number(Bun.env.PORT ?? 3000),
    databasePath: Bun.env.DATABASE_PATH ?? "data/radar.sqlite",
    adminToken: Bun.env.ADMIN_TOKEN ?? "",
    geminiApiKey: Bun.env.GEMINI_API_KEY ?? "",
    embeddingModel: Bun.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
    digestModel: Bun.env.DIGEST_MODEL ?? "gemini-2.5-flash",
    extractionModel: Bun.env.EXTRACTION_MODEL ?? "gemini-2.5-flash",
    mapboxToken: Bun.env.MAPBOX_TOKEN ?? "",
};

/** Ajustes editables desde el dashboard (se guardan en la tabla `settings`). */
export const SETTING_DEFAULTS = {
    /** Similitud mínima (coseno) para agrupar un artículo en un evento existente. */
    eventSimilarity: 0.82,
    /** Un evento sin noticias durante más de este tiempo ya no recibe artículos: está caducado. */
    eventWindowHours: 48,
    /** Suelo (en horas) del tiempo sin noticias tras el cual un evento deja de estar "activo". */
    eventActiveMinHours: 6,
    retentionDays: 30,
    maxArticleAgeHours: 72,
    schedulerEnabled: 1,

    enrichEnabled: 1,
    /** Medios distintos mínimos para que un evento merezca una llamada al LLM. */
    enrichMinSources: 2,
    enrichMaxEventsPerRun: 20,
    /** Similitud mínima para fusionar dos menciones en la misma entidad. */
    entityMergeSimilarity: 0.9,
    geocodingEnabled: 1,
    /** Las entidades sin eventos se conservan este tiempo (mucho más que los artículos). */
    entityRetentionDays: 180,
};