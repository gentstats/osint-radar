import { SETTING_DEFAULTS } from "./config";
import { db } from "./db";

export type Settings = typeof SETTING_DEFAULTS;

export function getSettings(): Settings {
    const rows = db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
    const stored = Object.fromEntries(rows.map((row) => [row.key, Number(row.value)]));
    return { ...SETTING_DEFAULTS, ...stored };
}

export function updateSettings(patch: Partial<Settings>): Settings {
    const upsert = db.query(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) upsert.run(key, String(value));
    }
    return getSettings();
}