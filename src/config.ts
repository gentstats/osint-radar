export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Dimensiones del vector. Si lo cambias, usa "Reindexar todo" en el dashboard. */
export const EMBEDDING_DIMENSIONS = 768;

export const env = {
    port: Number(Bun.env.PORT ?? 3000),
    databasePath: Bun.env.DATABASE_PATH ?? "data/radar.sqlite",
    adminToken: Bun.env.ADMIN_TOKEN ?? "",
    geminiApiKey: Bun.env.GEMINI_API_KEY ?? "",
    embeddingModel: Bun.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
    digestModel: Bun.env.DIGEST_MODEL ?? "gemini-2.5-flash",
};

/** Ajustes editables desde el dashboard (se guardan en la tabla `settings`). */
export const SETTING_DEFAULTS = {
    /** Similitud mínima (coseno) para agrupar un artículo en un evento existente. */
    eventSimilarity: 0.82,
    eventWindowHours: 48,
    retentionDays: 30,
    maxArticleAgeHours: 72,
    schedulerEnabled: 1,
};