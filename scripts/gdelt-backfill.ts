// scripts/gdelt-backfill.ts
//
// Uso por defecto (últimos 30 días, todos los idiomas):
//   bun scripts/gdelt-backfill.ts
//
// Opciones útiles:
//   bun scripts/gdelt-backfill.ts --days=1                # Probar primero con 24h
//   bun scripts/gdelt-backfill.ts --langs=spa,eng         # Guardar solo español e inglés
//   bun scripts/gdelt-backfill.ts --concurrency=10        # Hilos de descarga paralela
//   bun scripts/gdelt-backfill.ts --summary               # Solo imprimir resumen de la DB actual

import { Database } from "bun:sqlite";
import { mkdirSync, statSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { inflateRawSync } from "node:zlib";

// ---------- Configuración y argumentos CLI ----------

function getArg(name: string): string | undefined {
    const prefix = `--${name}=`;
    const match = Bun.argv.find((a) => a.startsWith(prefix));
    return match ? match.slice(prefix.length) : undefined;
}
const hasFlag = (name: string) => Bun.argv.includes(`--${name}`);

const DAYS = Number(getArg("days") ?? 30);
const CONCURRENCY = Math.max(1, Number(getArg("concurrency") ?? 8));
const DB_PATH = getArg("db") ?? "data/gdelt-month.sqlite";
const SUMMARY_ONLY = hasFlag("summary");
const ALLOWED_LANGS = getArg("langs")
    ? new Set(getArg("langs")!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;

const MASTER_LISTS = [
    { feed: "english", url: "http://data.gdeltproject.org/gdeltv2/masterfilelist.txt" },
    { feed: "translated", url: "http://data.gdeltproject.org/gdeltv2/masterfilelist-translation.txt" },
] as const;

// ---------- Base de datos (bun:sqlite) ----------

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH, { create: true });

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -64000;

  CREATE TABLE IF NOT EXISTS ingested_files (
    url TEXT PRIMARY KEY,
    feed TEXT NOT NULL,
    file_ts INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'not_found', 'error')),
    articles_inserted INTEGER NOT NULL DEFAULT 0,
    processed_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_files_status ON ingested_files(status);

  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY,
    record_id TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    domain TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    language TEXT NOT NULL,
    themes TEXT NOT NULL,
    locations TEXT NOT NULL,
    persons TEXT NOT NULL,
    organizations TEXT NOT NULL,
    tone REAL NOT NULL,
    feed TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
  CREATE INDEX IF NOT EXISTS idx_articles_lang ON articles(language);
  CREATE INDEX IF NOT EXISTS idx_articles_domain ON articles(domain);
`);

// ---------- Tipos ----------

interface MasterFileEntry {
    feed: string;
    url: string;
    fileTs: number;
    expectedBytes: number;
}

interface ParsedArticle {
    recordId: string;
    publishedAt: number;
    domain: string;
    url: string;
    title: string;
    language: string;
    themes: string;
    locations: string;
    persons: string;
    organizations: string;
    tone: number;
    feed: string;
}

// ---------- Lectura eficiente del masterfilelist ----------

/**
 * Descarga solo los últimos ~4 MB del masterfilelist usando Range HTTP
 * (cubre ~3 meses de histórico y evita bajar los >150 MB desde 2015).
 */
async function fetchMasterListTail(listUrl: string, feed: string, cutoffMs: number): Promise<MasterFileEntry[]> {
    const TAIL_BYTES = 4_500_000;
    let res = await fetch(listUrl, {
        headers: { Range: `bytes=-${TAIL_BYTES}` },
        signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 416) {
        res = await fetch(listUrl, { signal: AbortSignal.timeout(60_000) });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} al leer ${listUrl}`);

    let text = await res.text();
    // Si recibimos un corte parcial (HTTP 206), descartamos la primera línea porque puede venir partida
    if (res.status === 206) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline !== -1) text = text.slice(firstNewline + 1);
    }

    const entries: MasterFileEntry[] = [];
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const parts = trimmed.split(/\s+/);
        if (parts.length < 3) continue;

        const url = parts[2];
        if (!url.endsWith(".gkg.csv.zip")) continue;

        const tsMatch = url.match(/\/(\d{14})\.(?:translation\.)?gkg\.csv\.zip$/);
        if (!tsMatch) continue;

        const fileTs = parseGdeltDateMs(tsMatch[1]);
        if (fileTs < cutoffMs) continue;

        entries.push({
            feed,
            url,
            fileTs,
            expectedBytes: Number(parts[0]) || 0,
        });
    }

    return entries;
}

// ---------- Descompresión ZIP y parsing GKG 2.1 ----------

function unzipFirstFile(zipBuffer: Uint8Array): string {
    const view = new DataView(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength);

    let eocdOffset = -1;
    for (let i = zipBuffer.length - 22; i >= Math.max(0, zipBuffer.length - 65_557); i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset === -1) throw new Error("ZIP inválido (EOCD no encontrado)");

    const cdOffset = view.getUint32(eocdOffset + 16, true);
    if (view.getUint32(cdOffset, true) !== 0x02014b50) {
        throw new Error("ZIP inválido (Central Directory no encontrado)");
    }

    const compressionMethod = view.getUint16(cdOffset + 10, true);
    const compressedSize = view.getUint32(cdOffset + 20, true);
    const localHeaderOffset = view.getUint32(cdOffset + 42, true);

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const payload = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    const rawBytes = compressionMethod === 0 ? payload : inflateRawSync(payload);
    return new TextDecoder("utf-8").decode(rawBytes);
}

function parseGdeltDateMs(raw: string): number {
    const iso = raw.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z");
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
}

function decodeHtmlEntities(str: string): string {
    return str
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&apos;|&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function uniqueTokens(raw: string, delimiter: string, subIndex = 0, limit = 15): string {
    if (!raw) return "";
    const set = new Set<string>();
    for (const part of raw.split(";")) {
        const val = (subIndex >= 0 ? part.split(delimiter)[subIndex] : part)?.trim();
        if (val) {
            set.add(val);
            if (set.size >= limit) break;
        }
    }
    return [...set].join("|");
}

function parseGkgLine(line: string, feed: string): ParsedArticle | null {
    if (!line) return null;
    const cols = line.split("\t");
    if (cols.length < 27 || cols[2] !== "1") return null;

    const url = cols[4]?.trim();
    if (!url) return null;

    const langMatch = (cols[25] ?? "").match(/srclc:([a-z]{3})/i);
    const language = langMatch ? langMatch[1].toLowerCase() : "eng";
    if (ALLOWED_LANGS && !ALLOWED_LANGS.has(language)) return null;

    const extrasXml = cols[26] ?? "";
    const titleMatch = extrasXml.match(/<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim() : "";

    return {
        recordId: cols[0],
        publishedAt: parseGdeltDateMs(cols[1]) || Date.now(),
        domain: cols[3] ?? "",
        url,
        title,
        language,
        themes: uniqueTokens(cols[8] || cols[7] || "", ",", 0, 20),
        locations: uniqueTokens(cols[10] || cols[9] || "", "#", 1, 10),
        persons: uniqueTokens(cols[12] || cols[11] || "", ",", 0, 10),
        organizations: uniqueTokens(cols[14] || cols[13] || "", ",", 0, 10),
        tone: Number((cols[15] ?? "").split(",")[0]) || 0,
        feed,
    };
}

// ---------- Ingesta en paralelo ----------

const insertArticleStmt = db.query(`
  INSERT OR IGNORE INTO articles
    (record_id, published_at, domain, url, title, language, themes, locations, persons, organizations, tone, feed)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const markFileStmt = db.query(`
  INSERT INTO ingested_files (url, feed, file_ts, status, articles_inserted, processed_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(url) DO UPDATE SET
    status = excluded.status,
    articles_inserted = excluded.articles_inserted,
    processed_at = excluded.processed_at
`);

const saveBatchTx = db.transaction((entry: MasterFileEntry, articles: ParsedArticle[]) => {
    let inserted = 0;
    for (const a of articles) {
        inserted += insertArticleStmt.run(
            a.recordId,
            a.publishedAt,
            a.domain,
            a.url,
            a.title,
            a.language,
            a.themes,
            a.locations,
            a.persons,
            a.organizations,
            a.tone,
            a.feed
        ).changes;
    }
    markFileStmt.run(entry.url, entry.feed, entry.fileTs, "ok", inserted, Date.now());
    return inserted;
});

let stopRequested = false;
process.on("SIGINT", () => {
    if (!stopRequested) {
        console.log("\n\n🛑 Interrupción solicitada (SIGINT). Cerrando lotes en curso y guardando DB...");
        stopRequested = true;
    }
});

async function runBackfill(): Promise<void> {
    const cutoffMs = Date.now() - DAYS * 86_400_000;
    console.log(`\n📋 Consultando listados maestros de GDELT (últimos ${DAYS} días)...`);
    if (ALLOWED_LANGS) {
        console.log(`🌐 Filtro de idiomas activo: ${[...ALLOWED_LANGS].join(", ")}`);
    }

    const lists = await Promise.all(
        MASTER_LISTS.map((m) => fetchMasterListTail(m.url, m.feed, cutoffMs))
    );

    // Ordenar de más reciente a más antiguo para tener primero las noticias actuales
    const allEntries = lists.flat().sort((a, b) => b.fileTs - a.fileTs);

    const alreadyDone = new Set(
        db
            .query<{ url: string }, []>(
                "SELECT url FROM ingested_files WHERE status IN ('ok', 'not_found')"
            )
            .all()
            .map((r) => r.url)
    );

    const pending = allEntries.filter((e) => !alreadyDone.has(e.url));
    const totalMbPending = pending.reduce((acc, e) => acc + e.expectedBytes, 0) / 1024 / 1024;

    console.log(`📦 Archivos en los últimos ${DAYS} días: ${allEntries.length}`);
    console.log(`   ✅ Ya procesados en DB: ${allEntries.length - pending.length}`);
    console.log(`   ⏳ Pendientes por descargar: ${pending.length} (~${totalMbPending.toFixed(1)} MB comprimidos)\n`);

    if (pending.length === 0) return;

    let cursor = 0;
    let completed = 0;
    let totalInserted = 0;
    let notFound = 0;
    let errors = 0;
    const startedAt = Date.now();

    async function worker() {
        while (!stopRequested) {
            const idx = cursor++;
            if (idx >= pending.length) break;

            const entry = pending[idx];
            try {
                const res = await fetch(entry.url, { signal: AbortSignal.timeout(30_000) });

                if (res.status === 404) {
                    markFileStmt.run(entry.url, entry.feed, entry.fileTs, "not_found", 0, Date.now());
                    notFound++;
                } else if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                } else {
                    const zipBytes = new Uint8Array(await res.arrayBuffer());
                    const tsv = unzipFirstFile(zipBytes);
                    const articles: ParsedArticle[] = [];
                    for (const line of tsv.split("\n")) {
                        const parsed = parseGkgLine(line, entry.feed);
                        if (parsed) articles.push(parsed);
                    }
                    totalInserted += saveBatchTx(entry, articles);
                }
            } catch (err) {
                errors++;
                markFileStmt.run(entry.url, entry.feed, entry.fileTs, "error", 0, Date.now());
            }

            completed++;
            if (completed % 20 === 0 || completed === pending.length) {
                const elapsedSec = (Date.now() - startedAt) / 1000;
                const rate = completed / Math.max(0.1, elapsedSec);
                const etaMin = (pending.length - completed) / Math.max(0.01, rate) / 60;
                const pct = ((completed / pending.length) * 100).toFixed(1);
                process.stdout.write(
                    `\r⚡ Progreso: ${completed}/${pending.length} (${pct}%) | +${totalInserted.toLocaleString("es-ES")} noticias | ` +
                    `404: ${notFound} | Err: ${errors} | ETA: ${etaMin.toFixed(1)} min   `
                );
            }
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    console.log("\n");
}

// ---------- Resumen de la base de datos ----------

function getDbFileSizeMb(path: string): number {
    let bytes = existsSync(path) ? statSync(path).size : 0;
    if (existsSync(`${path}-wal`)) bytes += statSync(`${path}-wal`).size;
    return bytes / 1024 / 1024;
}

function printDatabaseSummary(): void {
    db.exec("PRAGMA wal_checkpoint(PASSIVE);");

    const fileStats = db
        .query<{ status: string; n: number }, []>(
            "SELECT status, COUNT(*) AS n FROM ingested_files GROUP BY status"
        )
        .all();

    const totals = db
        .query<{
            total: number;
            with_title: number;
            min_ts: number | null;
            max_ts: number | null;
            avg_tone: number | null;
            unique_domains: number;
        }, []>(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN title != '' THEN 1 ELSE 0 END) AS with_title,
        MIN(published_at) AS min_ts,
        MAX(published_at) AS max_ts,
        AVG(tone) AS avg_tone,
        COUNT(DISTINCT domain) AS unique_domains
      FROM articles
    `)
        .get()!;

    const topLangs = db
        .query<{ language: string; n: number }, []>(
            "SELECT language, COUNT(*) AS n FROM articles GROUP BY language ORDER BY n DESC LIMIT 10"
        )
        .all();

    const topDomains = db
        .query<{ domain: string; n: number }, []>(
            "SELECT domain, COUNT(*) AS n FROM articles WHERE domain != '' GROUP BY domain ORDER BY n DESC LIMIT 10"
        )
        .all();

    const dailyCounts = db
        .query<{ day: string; n: number }, []>(`
      SELECT strftime('%Y-%m-%d', published_at / 1000, 'unixepoch') AS day, COUNT(*) AS n
      FROM articles
      GROUP BY day
      ORDER BY day DESC
      LIMIT 15
    `)
        .all();

    // Contar temas y lugares frecuentes sobre los últimos 50.000 artículos para que sea instantáneo
    const themeCounts = new Map<string, number>();
    const locationCounts = new Map<string, number>();
    const sampleQuery = db.query<{ themes: string; locations: string }, []>(
        "SELECT themes, locations FROM articles ORDER BY published_at DESC LIMIT 50000"
    );
    for (const row of sampleQuery.iterate()) {
        if (row.themes) {
            for (const t of row.themes.split("|")) {
                if (t && !t.startsWith("TAX_") && !t.startsWith("WB_")) {
                    themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1);
                }
            }
        }
        if (row.locations) {
            for (const l of row.locations.split("|")) {
                if (l) locationCounts.set(l, (locationCounts.get(l) ?? 0) + 1);
            }
        }
    }
    const topThemes = [...themeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const topLocations = [...locationCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    const fmtDate = (ms: number | null) =>
        ms ? new Date(ms).toLocaleString("es-ES", { dateStyle: "medium", timeStyle: "short" }) : "—";

    console.log("=================================================================");
    console.log(" 📊 RESUMEN DE LA BASE DE DATOS GDELT (bun:sqlite)");
    console.log("=================================================================");
    console.log(` 📁 Archivo:          ${DB_PATH} (${getDbFileSizeMb(DB_PATH).toFixed(2)} MB en disco)`);
    console.log(` 🗂️  Estado archivos:  ${fileStats.map((s) => `${s.status}=${s.n}`).join(" | ") || "ninguno"}`);
    console.log(` 📰 Total artículos:  ${totals.total.toLocaleString("es-ES")}`);
    console.log(` 📝 Con titular:      ${(totals.with_title ?? 0).toLocaleString("es-ES")} (${totals.total ? (((totals.with_title ?? 0) / totals.total) * 100).toFixed(1) : 0}%)`);
    console.log(` 🌐 Medios únicos:    ${totals.unique_domains.toLocaleString("es-ES")}`);
    console.log(` 🗓️  Rango temporal:   ${fmtDate(totals.min_ts)}  →  ${fmtDate(totals.max_ts)}`);
    console.log(` 🎭 Tono medio:       ${totals.avg_tone !== null ? totals.avg_tone.toFixed(2) : "—"}`);

    if (topLangs.length > 0) {
        console.log("\n🌍 Top 10 Idiomas:");
        for (const row of topLangs) {
            const pct = ((row.n / totals.total) * 100).toFixed(1);
            console.log(`   - ${row.language.padEnd(6)} ${row.n.toLocaleString("es-ES").padStart(10)} (${pct}%)`);
        }
    }

    if (topDomains.length > 0) {
        console.log("\n🏢 Top 10 Dominios / Medios:");
        for (const row of topDomains) {
            console.log(`   - ${row.domain.padEnd(28)} ${row.n.toLocaleString("es-ES")}`);
        }
    }

    if (topThemes.length > 0) {
        console.log("\n🏷️  Top 10 Temas GKG (muestra últimos 50k artículos):");
        for (const [theme, count] of topThemes) {
            console.log(`   - ${theme.padEnd(32)} ${count.toLocaleString("es-ES")}`);
        }
    }

    if (topLocations.length > 0) {
        console.log("\n📍 Top 10 Lugares mencionados (muestra últimos 50k artículos):");
        for (const [loc, count] of topLocations) {
            console.log(`   - ${loc.padEnd(32)} ${count.toLocaleString("es-ES")}`);
        }
    }

    if (dailyCounts.length > 0) {
        console.log("\n📅 Volumen diario (últimos días registrados):");
        for (const row of dailyCounts) {
            console.log(`   - ${row.day}: ${row.n.toLocaleString("es-ES")} artículos`);
        }
    }

    const samples = db
        .query<{ language: string; domain: string; title: string }, []>(
            "SELECT language, domain, title FROM articles WHERE title != '' ORDER BY published_at DESC LIMIT 5"
        )
        .all();
    if (samples.length > 0) {
        console.log("\n🗞️  Últimos 5 titulares con título extraído:");
        for (const s of samples) {
            console.log(`   - [${s.language} | ${s.domain}] ${s.title.slice(0, 95)}`);
        }
    }
    console.log("=================================================================\n");
}

// ---------- Punto de entrada ----------

try {
    if (!SUMMARY_ONLY) {
        await runBackfill();
    }
    printDatabaseSummary();
} finally {
    db.close();
}