import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('rss', 'gdelt')),
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT 30,
  last_fetched_at INTEGER,
  last_error TEXT,
  articles_total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  examples TEXT NOT NULL DEFAULT '',
  threshold REAL NOT NULL DEFAULT 0.6,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS category_vectors (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  centroid BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL DEFAULT '',
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processed')),
  embedding BLOB,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles(status);
CREATE INDEX IF NOT EXISTS idx_articles_event ON articles(event_id);

CREATE TABLE IF NOT EXISTS article_categories (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  PRIMARY KEY (article_id, category_id)
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  details TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  content TEXT NOT NULL
);
`;

mkdirSync(dirname(env.databasePath), { recursive: true });

export const db = new Database(env.databasePath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(SCHEMA);

type Binding = string | number | null | undefined;

/**
 * Actualiza solo las columnas presentes en `patch`.
 * Los nombres de columna salen de esquemas zod (nunca directamente del usuario).
 */
export function updateRow(table: string, id: number, patch: Record<string, Binding>): void {
    const entries = Object.entries(patch).filter(
        (entry): entry is [string, string | number | null] => entry[1] !== undefined,
    );
    if (entries.length === 0) return;

    const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
    db.query(`UPDATE ${table} SET ${assignments} WHERE id = ?`).run(
        ...entries.map(([, value]) => value),
        id,
    );
}