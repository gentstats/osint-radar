// scripts/test-lmstudio-events.ts
//
// Uso por defecto (usa la caché de embeddings de `data/gdelt-month.sqlite` y genera `data/events-llm.md`):
//   bun scripts/test-lmstudio-events.ts
//
// Opciones útiles:
//   bun scripts/test-lmstudio-events.ts --langs=spa              # Solo eventos en español
//   bun scripts/test-lmstudio-events.ts --threshold=0.78         # Ajustar similitud (sin re-embedear)
//   bun scripts/test-lmstudio-events.ts --min-sources=3          # Mínimo de medios distintos
//   bun scripts/test-lmstudio-events.ts --max-export=250         # Máximo de eventos en el Markdown (0 = todos)
//   bun scripts/test-lmstudio-events.ts --out=data/briefing.md   # Ruta del Markdown de salida

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ---------- Configuración CLI ----------

function getArg(name: string): string | undefined {
    const prefix = `--${name}=`;
    const found = Bun.argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
}

const DB_PATH = getArg("db") ?? "data/gdelt-month.sqlite";
const LM_STUDIO_URL = getArg("url") ?? "http://127.0.0.1:1234/v1/embeddings";
const MODEL_ID = getArg("model") ?? "text-embedding-embeddinggemma-2";
const BATCH_SIZE = Number(getArg("batch") ?? 16);
const THRESHOLD = Number(getArg("threshold") ?? 0.80);
const MIN_SOURCES = Number(getArg("min-sources") ?? 3);
const WINDOW_HOURS = Number(getArg("window") ?? 48);
const LIMIT = Number(getArg("limit") ?? 0);
const OUT_PATH = getArg("out") ?? "data/events-llm.md";
const MAX_EXPORT = Number(getArg("max-export") ?? 100_000);
const ALLOWED_LANGS = getArg("langs")
    ? new Set(getArg("langs")!.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;

// ---------- Reglas de limpieza ----------

const SPAM_DOMAINS = new Set([
    "zazoom.it",
    "motorward.com",
    "inewsgr.com",
    "naslovi.net",
    "baomoi.com",
    "iheart.com",
]);

const JUNK_TITLE_RE =
    /^(access denied|just a moment|attention required|403 forbidden|404 not found|page not found|untitled|subscribe|enable javascript|cloudflare|error \d{3}|cookie|privacy policy)/i;

const PREFIX_NOISE_RE =
    /^(?:BREAKING(?:\s+NEWS)?|ÚLTIMA HORA|EN DIRECTO|LIVE|VIDEO|OPINIÓN|FOTOS)\s*[:|\-–—]\s+/i;

const SUFFIX_OUTLET_RE = /\s+[|\-–—]\s+[^|\-–—]{2,35}$/;

function cleanHeadline(rawTitle: string): string | null {
    let t = rawTitle.replace(/\s+/g, " ").trim();
    if (!t || JUNK_TITLE_RE.test(t)) return null;

    t = t.replace(PREFIX_NOISE_RE, "").trim();

    const stripped = t.replace(SUFFIX_OUTLET_RE, "").trim();
    if (stripped.length >= 28 && stripped.split(" ").length >= 4) {
        t = stripped;
    }

    if (t.length < 25 || t.split(" ").length < 4) return null;
    return t.slice(0, 260);
}

function normKey(text: string): string {
    return text
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

// ---------- Base de datos y caché ----------

const db = new Database(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;

  CREATE TABLE IF NOT EXISTS article_embeddings (
    article_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    embedding BLOB NOT NULL,
    PRIMARY KEY (article_id, model)
  );
`);

interface RawRow {
    id: number;
    published_at: number;
    domain: string;
    url: string;
    title: string;
    language: string;
    locations: string;
    organizations: string;
    persons: string;
    themes: string;
    embedding: Uint8Array | null;
}

interface CleanArticle {
    id: number;
    publishedAt: number;
    domain: string;
    url: string;
    rawTitle: string;
    cleanTitle: string;
    titleHash: string;
    language: string;
    locations: string[];
    actors: string[];
    themes: string[];
    vector: Float32Array | null;
}

function loadAndCleanArticles(): { articles: CleanArticle[]; stats: Record<string, number> } {
    const stats = {
        totalWithTitle: 0,
        skippedLang: 0,
        skippedSpamDomain: 0,
        skippedJunkTitle: 0,
        skippedSameDomainDup: 0,
        kept: 0,
        alreadyCached: 0,
    };

    const limitSql = LIMIT > 0 ? `LIMIT ${LIMIT}` : "";
    const query = db.query<RawRow, [string]>(`
    SELECT
      a.id, a.published_at, a.domain, a.url, a.title, a.language,
      a.locations, a.organizations, a.persons, a.themes,
      ae.embedding
    FROM articles a
    LEFT JOIN article_embeddings ae ON ae.article_id = a.id AND ae.model = ?
    WHERE a.title != ''
    ORDER BY a.published_at DESC
    ${limitSql}
  `);

    const seenPerDomain = new Set<string>();
    const articles: CleanArticle[] = [];

    for (const row of query.iterate(MODEL_ID)) {
        stats.totalWithTitle++;

        const lang = row.language.toLowerCase();
        if (ALLOWED_LANGS && !ALLOWED_LANGS.has(lang)) {
            stats.skippedLang++;
            continue;
        }

        const domain = row.domain.toLowerCase();
        if (SPAM_DOMAINS.has(domain)) {
            stats.skippedSpamDomain++;
            continue;
        }

        const cleanTitle = cleanHeadline(row.title);
        if (!cleanTitle) {
            stats.skippedJunkTitle++;
            continue;
        }

        const titleHash = normKey(cleanTitle);
        const domainDedupKey = `${domain}|${titleHash}`;
        if (seenPerDomain.has(domainDedupKey)) {
            stats.skippedSameDomainDup++;
            continue;
        }
        seenPerDomain.add(domainDedupKey);

        const vector = row.embedding ? new Float32Array(row.embedding.slice().buffer) : null;
        if (vector) stats.alreadyCached++;

        articles.push({
            id: row.id,
            publishedAt: row.published_at,
            domain,
            url: row.url,
            rawTitle: row.title,
            cleanTitle,
            titleHash,
            language: lang,
            locations: row.locations ? row.locations.split("|").filter(Boolean) : [],
            actors: [
                ...(row.organizations ? row.organizations.split("|") : []),
                ...(row.persons ? row.persons.split("|") : []),
            ].filter(Boolean),
            themes: row.themes
                ? row.themes.split("|").filter((t) => t && !t.startsWith("TAX_") && !t.startsWith("WB_"))
                : [],
            vector,
        });
    }

    stats.kept = articles.length;
    articles.sort((a, b) => a.publishedAt - b.publishedAt);
    return { articles, stats };
}

// ---------- Cliente LM Studio resiliente ----------

function normalizeVec(values: ArrayLike<number>): Float32Array {
    const vec = Float32Array.from(values);
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
}

async function fetchEmbeddingsFromLmStudio(texts: string[]): Promise<Float32Array[]> {
    let res: Response;
    try {
        res = await fetch(LM_STUDIO_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: MODEL_ID, input: texts }),
            signal: AbortSignal.timeout(60_000),
        });
    } catch (err: any) {
        throw new Error(`No se pudo conectar a LM Studio en ${LM_STUDIO_URL}: ${err.message}`);
    }

    if (!res.ok) {
        throw new Error(`LM Studio HTTP ${res.status}: ${(await res.text()).slice(0, 250)}`);
    }

    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    return json.data.sort((a, b) => a.index - b.index).map((item) => normalizeVec(item.embedding));
}

const saveEmbedStmt = db.query(
    "INSERT OR REPLACE INTO article_embeddings (article_id, model, embedding) VALUES (?, ?, ?)"
);

const saveEmbedBatchTx = db.transaction((items: CleanArticle[], vectors: (Float32Array | null)[]) => {
    for (let i = 0; i < items.length; i++) {
        const v = vectors[i];
        if (!v) continue;
        items[i].vector = v;
        saveEmbedStmt.run(items[i].id, MODEL_ID, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    }
});

async function embedBatchResilient(items: CleanArticle[]): Promise<(Float32Array | null)[]> {
    const inputs = items.map((a) =>
        MODEL_ID.includes("nomic") ? `clustering: ${a.cleanTitle}` : a.cleanTitle
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            return await fetchEmbeddingsFromLmStudio(inputs);
        } catch (err: any) {
            const msg = String(err.message ?? err);
            const isRecoverable =
                msg.includes("Model reloaded") ||
                msg.includes("RPC Error") ||
                msg.includes("HTTP 5") ||
                msg.includes("No se pudo conectar");

            if (isRecoverable && attempt < 3) {
                console.warn(`\n⚠️ LM Studio recargando modelo (intento ${attempt}/3). Esperando 3s...`);
                await Bun.sleep(3_000);
                continue;
            }

            if (items.length > 1) {
                const mid = Math.ceil(items.length / 2);
                console.warn(`\n⚠️ Dividiendo lote de ${items.length} en ${mid} + ${items.length - mid}...`);
                const left = await embedBatchResilient(items.slice(0, mid));
                const right = await embedBatchResilient(items.slice(mid));
                return [...left, ...right];
            }

            console.warn(`\n⚠️ Saltando artículo #${items[0].id} tras error persistente: ${msg.slice(0, 100)}`);
            return [null];
        }
    }
    return items.map(() => null);
}

let stopRequested = false;
process.on("SIGINT", () => {
    if (!stopRequested) {
        console.log("\n🛑 Interrupción detectada: terminando lote actual y agrupando lo procesado...");
        stopRequested = true;
    }
});

async function ensureEmbeddings(articles: CleanArticle[]): Promise<CleanArticle[]> {
    const pending = articles.filter((a) => a.vector === null);
    if (pending.length === 0) {
        console.log("⚡ Todos los embeddings ya estaban en caché SQLite.\n");
        return articles;
    }

    console.log(`🧠 Generando embeddings en LM Studio (${MODEL_ID}) para ${pending.length.toLocaleString("es-ES")} noticias...`);
    const t0 = performance.now();
    let done = 0;

    for (let i = 0; i < pending.length && !stopRequested; i += BATCH_SIZE) {
        const batch = pending.slice(i, i + BATCH_SIZE);
        const vectors = await embedBatchResilient(batch);
        saveEmbedBatchTx(batch, vectors);

        done += batch.length;
        const elapsedSec = (performance.now() - t0) / 1000;
        const rate = done / Math.max(0.1, elapsedSec);
        const etaSec = (pending.length - done) / Math.max(0.1, rate);
        const pct = ((done / pending.length) * 100).toFixed(1);

        process.stdout.write(
            `\r   Embeddings: ${done.toLocaleString("es-ES")}/${pending.length.toLocaleString("es-ES")} (${pct}%) | ` +
            `${rate.toFixed(0)} art/s | ETA: ${(etaSec / 60).toFixed(1)} min   `
        );
    }
    console.log("\n");
    return articles.filter((a) => a.vector !== null);
}

// ---------- Clustering ultrarrápido (SimHash ortogonalizado + arrays planos) ----------

function computeMeanDirection(articles: CleanArticle[], dims: number): Float32Array {
    const mean = new Float32Array(dims);
    for (const a of articles) {
        const v = a.vector!;
        for (let i = 0; i < dims; i++) mean[i] += v[i];
    }
    return normalizeVec(mean);
}

function createSimHasher(dims: number, meanDir: Float32Array) {
    let seed = 133742;
    const rand = () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return ((seed >>> 0) / 0xffffffff) * 2 - 1;
    };

    const planes = Array.from({ length: 64 }, () => {
        const p = new Float32Array(dims);
        for (let i = 0; i < dims; i++) p[i] = rand();
        const proj = dot(p, meanDir);
        for (let i = 0; i < dims; i++) p[i] -= proj * meanDir[i];
        return normalizeVec(p);
    });

    return function signature(vec: Float32Array): [number, number] {
        let hi = 0;
        let lo = 0;
        for (let b = 0; b < 32; b++) {
            let s1 = 0;
            let s2 = 0;
            const p1 = planes[b];
            const p2 = planes[b + 32];
            for (let i = 0; i < dims; i++) {
                s1 += vec[i] * p1[i];
                s2 += vec[i] * p2[i];
            }
            if (s1 >= 0) hi |= 1 << b;
            if (s2 >= 0) lo |= 1 << b;
        }
        return [hi >>> 0, lo >>> 0];
    };
}

function popcount32(x: number): number {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function dot(a: Float32Array, b: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}

interface EventCluster {
    id: number;
    title: string;
    centroid: Float32Array;
    firstSeen: number;
    lastSeen: number;
    domains: Set<string>;
    languages: Set<string>;
    articles: CleanArticle[];
}

function clusterIntoEvents(articles: CleanArticle[]): EventCluster[] {
    if (articles.length === 0) return [];
    const t0 = performance.now();
    console.log(`🧩 Agrupando ${articles.length.toLocaleString("es-ES")} noticias en eventos...`);

    const dims = articles[0].vector!.length;
    const meanDir = computeMeanDirection(articles, dims);
    const sigOf = createSimHasher(dims, meanDir);
    const windowMs = WINDOW_HOURS * 3_600_000;

    const angleRatio = Math.acos(Math.max(-1, Math.min(1, THRESHOLD))) / Math.PI;
    const maxHamming = Math.min(28, Math.ceil(64 * angleRatio + 10));

    const clusters: EventCluster[] = [];
    const sigHis = new Uint32Array(articles.length);
    const sigLos = new Uint32Array(articles.length);
    const lastSeens = new Float64Array(articles.length);
    const titleMap = new Map<string, EventCluster>();
    let activeStartIdx = 0;

    for (let nIdx = 0; nIdx < articles.length; nIdx++) {
        const art = articles[nIdx];
        const vec = art.vector!;
        const count = clusters.length;

        while (activeStartIdx < count && art.publishedAt - lastSeens[activeStartIdx] > windowMs) {
            activeStartIdx++;
        }

        let matched = titleMap.get(art.titleHash);
        if (matched && art.publishedAt - matched.lastSeen > windowMs) {
            matched = undefined;
        }

        if (!matched) {
            const [hi, lo] = sigOf(vec);
            let bestScore = THRESHOLD;

            for (let i = activeStartIdx; i < count; i++) {
                if (popcount32(hi ^ sigHis[i]) + popcount32(lo ^ sigLos[i]) > maxHamming) continue;
                if (art.publishedAt - lastSeens[i] > windowMs) continue;

                const c = clusters[i];
                const score = dot(c.centroid, vec);
                if (score >= bestScore) {
                    bestScore = score;
                    matched = c;
                }
            }
        }

        if (matched) {
            const n = matched.articles.length;
            for (let i = 0; i < dims; i++) {
                matched.centroid[i] = matched.centroid[i] * n + vec[i];
            }
            matched.centroid = normalizeVec(matched.centroid);
            const [nhi, nlo] = sigOf(matched.centroid);
            sigHis[matched.id] = nhi;
            sigLos[matched.id] = nlo;

            matched.articles.push(art);
            matched.domains.add(art.domain);
            matched.languages.add(art.language);
            matched.lastSeen = Math.max(matched.lastSeen, art.publishedAt);
            lastSeens[matched.id] = matched.lastSeen;
        } else {
            const [hi, lo] = sigOf(vec);
            const id = clusters.length;
            const created: EventCluster = {
                id,
                title: art.cleanTitle,
                centroid: new Float32Array(vec),
                firstSeen: art.publishedAt,
                lastSeen: art.publishedAt,
                domains: new Set([art.domain]),
                languages: new Set([art.language]),
                articles: [art],
            };
            clusters.push(created);
            sigHis[id] = hi;
            sigLos[id] = lo;
            lastSeens[id] = art.publishedAt;
            titleMap.set(art.titleHash, created);
        }

        if ((nIdx + 1) % 2000 === 0 || nIdx + 1 === articles.length) {
            const elapsedSec = (performance.now() - t0) / 1000;
            const rate = (nIdx + 1) / Math.max(0.1, elapsedSec);
            const pct = (((nIdx + 1) / articles.length) * 100).toFixed(1);
            process.stdout.write(
                `\r   Clustering: ${(nIdx + 1).toLocaleString("es-ES")}/${articles.length.toLocaleString("es-ES")} (${pct}%) | ` +
                `${rate.toFixed(0)} art/s | Grupos: ${clusters.length.toLocaleString("es-ES")}   `
            );
        }
    }

    const sec = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`\n🧩 Clustering completado en ${sec}s (${clusters.length.toLocaleString("es-ES")} grupos totales)\n`);
    return clusters;
}

// ---------- Exportación Markdown LLM-friendly (compacta ~1/4 tokens, conservando titulares clave) ----------

function topFrequency(items: string[], max = 3): string[] {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
    return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, max)
        .map(([name]) => name);
}

const shortUtc = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");

/** Elige un título representativo priorizando español/inglés si existen en el grupo. */
function pickBestTitle(ev: EventCluster): string {
    const spa = ev.articles.find((a) => a.language === "spa");
    if (spa) return spa.cleanTitle;
    const eng = ev.articles.find((a) => a.language === "eng");
    if (eng) return eng.cleanTitle;
    return ev.title;
}

function titleWords(text: string): Set<string> {
    return new Set(
        normKey(text)
            .split(" ")
            .filter((w) => w.length >= 4)
    );
}

function isNearDuplicateTitle(candidate: Set<string>, existing: Set<string>[]): boolean {
    if (candidate.size === 0) return false;
    for (const prev of existing) {
        if (prev.size === 0) continue;
        let overlap = 0;
        for (const w of candidate) {
            if (prev.has(w)) overlap++;
        }
        if (overlap / Math.min(candidate.size, prev.size) >= 0.75) return true;
    }
    return false;
}

/** Selecciona hasta `max` titulares complementarios de dominios distintos, evitando repetir el titular principal. */
function pickComplementarySources(ev: EventCluster, mainTitle: string, max = 3): CleanArticle[] {
    const priority = (lang: string) => (lang === "spa" ? 0 : lang === "eng" ? 1 : 2);
    const sorted = [...ev.articles].sort(
        (a, b) => priority(a.language) - priority(b.language) || b.publishedAt - a.publishedAt
    );

    const mainHash = normKey(mainTitle);
    const seenDomains = new Set<string>();
    const seenWordSets: Set<string>[] = [titleWords(mainTitle)];
    const picked: CleanArticle[] = [];

    for (const art of sorted) {
        if (seenDomains.has(art.domain)) continue;
        if (art.titleHash === mainHash) continue;

        const words = titleWords(art.cleanTitle);
        if (isNearDuplicateTitle(words, seenWordSets)) continue;

        seenDomains.add(art.domain);
        seenWordSets.push(words);
        picked.push(art);
        if (picked.length >= max) break;
    }
    return picked;
}

function renderLlmMarkdown(
    events: EventCluster[],
    totalArticles: number,
    _totalClusters: number
): string {
    const exported = MAX_EXPORT > 0 ? events.slice(0, MAX_EXPORT) : events;
    const minSeen = exported.length ? Math.min(...exported.map((e) => e.firstSeen)) : Date.now();
    const maxSeen = exported.length ? Math.max(...exported.map((e) => e.lastSeen)) : Date.now();

    const lines: string[] = [
        `# Eventos OSINT (${shortUtc(minSeen)} .. ${shortUtc(maxSeen)} UTC · ${exported.length} eventos / ${totalArticles} art.)`,
        `> Formato: \`[ID] (medios/artículos · inicio, duración) Titular\` + metadatos y titulares complementarios.`,
        "",
    ];

    for (let i = 0; i < exported.length; i++) {
        const ev = exported[i];
        const eid = `E${String(i + 1).padStart(3, "0")}`;
        const title = pickBestTitle(ev);
        const spanH = Math.round((ev.lastSeen - ev.firstSeen) / 3_600_000);
        const locs = topFrequency(ev.articles.flatMap((a) => a.locations), 3);
        const actors = topFrequency(ev.articles.flatMap((a) => a.actors), 3);
        const samples = pickComplementarySources(ev, title, 3);

        lines.push(`**[${eid}]** (${ev.domains.size}m/${ev.articles.length}a · ${shortUtc(ev.firstSeen)}, ${spanH}h) ${title}`);

        const meta: string[] = [];
        if (locs.length) meta.push(`Lugares: ${locs.join("; ")}`);
        if (actors.length) meta.push(`Actores: ${actors.join("; ")}`);
        if (meta.length) lines.push(`- ${meta.join(" | ")}`);

        for (const s of samples) {
            lines.push(`  - ${s.domain}: ${s.cleanTitle}`);
        }
    }

    lines.push("");
    return lines.join("\n");
}

function printEventList(title: string, events: EventCluster[], limit = 15): void {
    console.log(`\n${title}`);
    console.log("─".repeat(80));
    for (const [idx, ev] of events.slice(0, limit).entries()) {
        const locs = topFrequency(ev.articles.flatMap((a) => a.locations), 3);
        console.log(
            `${String(idx + 1).padStart(2)}. [${ev.domains.size} medios | ${ev.articles.length} art.] ${pickBestTitle(ev)}`
        );
        if (locs.length) console.log(`    📍 ${locs.join(" · ")}`);
    }
}

// ---------- Ejecución principal ----------

try {
    console.log(`\n🧹 Cargando y limpiando noticias de ${DB_PATH}...`);
    const { articles: clean, stats } = loadAndCleanArticles();
    console.log(`   ✅ Noticias limpias válidas: ${stats.kept.toLocaleString("es-ES")} (${stats.alreadyCached.toLocaleString("es-ES")} ya en caché)\n`);

    const embedded = await ensureEmbeddings(clean);
    const clusters = clusterIntoEvents(embedded);

    const realEvents = clusters
        .filter((c) => c.domains.size >= MIN_SOURCES)
        .sort((a, b) => b.domains.size - a.domains.size || b.articles.length - a.articles.length);

    const coveredArticles = realEvents.reduce((acc, e) => acc + e.articles.length, 0);

    console.log("=================================================================");
    console.log(" 🌍 RESULTADO DE DETECCIÓN DE EVENTOS (100% LOCAL)");
    console.log("=================================================================");
    console.log(` Umbral: ${THRESHOLD} | Ventana: ${WINDOW_HOURS}h | Mín. medios: ${MIN_SOURCES}`);
    console.log(` Artículos procesados: ${embedded.length.toLocaleString("es-ES")}`);
    console.log(` 🔥 EVENTOS REALES:    ${realEvents.length.toLocaleString("es-ES")} (agrupan ${coveredArticles.toLocaleString("es-ES")} noticias)`);

    printEventList(`🏆 TOP 15 EVENTOS GLOBALES (≥ ${MIN_SOURCES} medios)`, realEvents, 15);

    const markdown = renderLlmMarkdown(realEvents, embedded.length, clusters.length);
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    await Bun.write(OUT_PATH, markdown);

    const kb = (Buffer.byteLength(markdown, "utf8") / 1024).toFixed(1);
    const approxTokens = Math.round(markdown.length / 4).toLocaleString("es-ES");
    console.log(`\n📄 Markdown LLM-friendly guardado en: ${OUT_PATH} (${kb} KB · ~${approxTokens} tokens)\n`);
} finally {
    db.close();
}