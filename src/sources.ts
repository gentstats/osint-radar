import { db, updateRow } from "./db";
import type { SourceInput, SourcePatch } from "./schemas";
import type { Source } from "./types";

export const listSources = (): Source[] =>
    db.query<Source, []>("SELECT * FROM sources ORDER BY name").all();

export const getSource = (id: number): Source | null =>
    db.query<Source, [number]>("SELECT * FROM sources WHERE id = ?").get(id);

export function createSource(input: SourceInput): Source {
    const { lastInsertRowid } = db
        .query("INSERT INTO sources (name, type, url, interval_minutes, enabled) VALUES (?, ?, ?, ?, ?)")
        .run(input.name, input.type, input.url, input.interval_minutes, input.enabled);
    return getSource(Number(lastInsertRowid))!;
}

export function updateSource(id: number, patch: SourcePatch): Source | null {
    updateRow("sources", id, patch);
    return getSource(id);
}

export const deleteSource = (id: number): boolean =>
    db.query("DELETE FROM sources WHERE id = ?").run(id).changes > 0;

export function markSourceFetched(id: number, at: number, error: string | null, added: number): void {
    db.query(
        "UPDATE sources SET last_fetched_at = ?, last_error = ?, articles_total = articles_total + ? WHERE id = ?",
    ).run(at, error, added, id);
}