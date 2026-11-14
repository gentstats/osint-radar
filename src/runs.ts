import { db } from "./db";

export interface RunRow {
    id: number;
    kind: string;
    started_at: number;
    duration_ms: number;
    ok: number;
    details: string;
}

export function recordRun(kind: string, startedAt: number, ok: boolean, details: object): void {
    db.query(
        "INSERT INTO runs (kind, started_at, duration_ms, ok, details) VALUES (?, ?, ?, ?, ?)",
    ).run(kind, startedAt, Date.now() - startedAt, ok ? 1 : 0, JSON.stringify(details));
}

export const listRuns = (limit = 30): RunRow[] =>
    db.query<RunRow, [number]>("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit);