import { z } from "zod";

/** El dashboard envía booleanos; SQLite guarda 0/1. */
const flag = z.boolean().transform((value) => (value ? 1 : 0));

export const sourceSchema = z.object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(["rss", "gdelt"]),
    url: z.string().trim().min(1).max(1000),
    interval_minutes: z.number().int().min(5).max(1440).default(30),
    enabled: flag.default(1),
});
export const sourcePatchSchema = sourceSchema.partial();

export const categorySchema = z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(10).max(1000),
    examples: z.string().max(4000).default(""),
    threshold: z.number().min(0.3).max(0.95).default(0.6),
    enabled: flag.default(1),
});
export const categoryPatchSchema = categorySchema.partial();

export const settingsSchema = z
    .object({
        eventSimilarity: z.number().min(0.5).max(0.99),
        eventWindowHours: z.number().int().min(1).max(168),
        eventActiveMinHours: z.number().min(1).max(168),
        retentionDays: z.number().int().min(1).max(365),
        maxArticleAgeHours: z.number().int().min(1).max(720),
        schedulerEnabled: flag,
        enrichEnabled: flag,
        enrichMinSources: z.number().int().min(1).max(10),
        enrichMaxEventsPerRun: z.number().int().min(1).max(100),
        entityMergeSimilarity: z.number().min(0.7).max(0.99),
        geocodingEnabled: flag,
        entityRetentionDays: z.number().int().min(1).max(1095),
    })
    .partial();

export type SourceInput = z.infer<typeof sourceSchema>;
export type SourcePatch = z.infer<typeof sourcePatchSchema>;
export type CategoryInput = z.infer<typeof categorySchema>;
export type CategoryPatch = z.infer<typeof categoryPatchSchema>;