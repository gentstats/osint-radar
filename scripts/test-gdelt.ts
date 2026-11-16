// scripts/test-gdelt.ts
// Ejecutar: bun scripts/test-gdelt.ts
import { inflateRawSync } from "node:zlib";

interface GkgArticle {
    recordId: string;
    date: Date;
    domain: string;
    url: string;
    title: string;
    language: string;
    themes: string[];
    locations: string[];
    persons: string[];
    organizations: string[];
    tone: number;
}

const FEEDS = {
    english: "http://data.gdeltproject.org/gdeltv2/lastupdate.txt",
    translated: "http://data.gdeltproject.org/gdeltv2/lastupdate-translation.txt",
};

/** Lee `lastupdate*.txt` y devuelve la URL del `.gkg.csv.zip` más reciente. */
async function getLatestGkgUrl(feedUrl: string): Promise<string> {
    const res = await fetch(feedUrl);
    if (!res.ok) throw new Error(`Error al leer ${feedUrl}: HTTP ${res.status}`);
    const text = await res.text();

    const line = text.split("\n").find((l) => l.includes(".gkg.csv.zip"));
    if (!line) throw new Error(`No se encontró .gkg.csv.zip en ${feedUrl}`);
    return line.trim().split(/\s+/)[2];
}

/** Retrocede `steps * 15 min` sobre una URL tipo `.../20261115100000.translation.gkg.csv.zip`. */
function shiftGdeltUrl(url: string, stepsBack15Min: number): string {
    if (stepsBack15Min === 0) return url;
    return url.replace(/(\d{14})(\.(?:translation\.)?gkg\.csv\.zip)$/, (_, ts: string, suffix: string) => {
        const date = parseGdeltDate(ts);
        const shifted = new Date(date.getTime() - stepsBack15Min * 15 * 60_000);
        const formatted = shifted.toISOString().replace(/[-:T]/g, "").slice(0, 14);
        return `${formatted}${suffix}`;
    });
}

/** Descomprime un ZIP de un solo archivo en memoria usando node:zlib (sin paquetes npm). */
function unzipFirstFile(zipBuffer: Uint8Array): string {
    const view = new DataView(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength);

    // Buscar la firma End of Central Directory (0x06054b50) desde el final
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

    // Leer Local File Header para saltar nombre de archivo y campos extra
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const payload = zipBuffer.subarray(dataStart, dataStart + compressedSize);

    const rawBytes = compressionMethod === 0 ? payload : inflateRawSync(payload);
    return new TextDecoder("utf-8").decode(rawBytes);
}

/** Parsea una línea TSV del esquema GKG 2.1 (27 columnas). */
function parseGkgLine(line: string): GkgArticle | null {
    if (!line) return null;
    const cols = line.split("\t");
    if (cols.length < 27) return null;

    // SourceCollectionIdentifier === "1" significa URL web pública
    if (cols[2] !== "1") return null;

    const extrasXml = cols[26] ?? "";
    const titleMatch = extrasXml.match(/<PAGE_TITLE>([\s\S]*?)<\/PAGE_TITLE>/);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : "";

    const langMatch = (cols[25] ?? "").match(/srclc:([a-z]{3})/i);
    const language = langMatch ? langMatch[1].toLowerCase() : "eng";

    const themes = (cols[8] || cols[7] || "")
        .split(";")
        .map((t) => t.split(",")[0])
        .filter(Boolean);

    const locations = (cols[10] || cols[9] || "")
        .split(";")
        .map((l) => l.split("#")[1])
        .filter(Boolean);

    const persons = (cols[12] || cols[11] || "")
        .split(";")
        .map((p) => p.split(",")[0])
        .filter(Boolean);

    const organizations = (cols[14] || cols[13] || "")
        .split(";")
        .map((o) => o.split(",")[0])
        .filter(Boolean);

    const tone = Number((cols[15] ?? "").split(",")[0]) || 0;

    return {
        recordId: cols[0],
        date: parseGdeltDate(cols[1]),
        domain: cols[3],
        url: cols[4],
        title,
        language,
        themes: [...new Set(themes)],
        locations: [...new Set(locations)],
        persons: [...new Set(persons)],
        organizations: [...new Set(organizations)],
        tone,
    };
}

function parseGdeltDate(raw: string): Date {
    const iso = raw.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1-$2-$3T$4:$5:$6Z");
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? new Date() : new Date(ms);
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

/** Descarga y parsea el último lote GKG disponible, retrocediendo en saltos de 15 min si da 404. */
async function fetchGkgBatch(feedUrl: string, label: string, maxStepsBack = 6): Promise<GkgArticle[]> {
    const t0 = performance.now();
    const latestUrl = await getLatestGkgUrl(feedUrl);

    let zipBytes: Uint8Array | null = null;
    let usedUrl = latestUrl;

    for (let step = 0; step <= maxStepsBack; step++) {
        usedUrl = shiftGdeltUrl(latestUrl, step);
        console.log(`📡 [${label}] Probando: ${usedUrl}`);

        const res = await fetch(usedUrl);
        if (res.ok) {
            zipBytes = new Uint8Array(await res.arrayBuffer());
            break;
        }

        if (res.status === 404) {
            console.warn(`⚠️ [${label}] HTTP 404 (lote no disponible aún). Retrocediendo 15 min...`);
            continue;
        }

        throw new Error(`HTTP ${res.status} en ${usedUrl}`);
    }

    if (!zipBytes) {
        throw new Error(`[${label}] No se encontró ningún lote válido tras retroceder ${maxStepsBack * 15} min.`);
    }

    const tsv = unzipFirstFile(zipBytes);
    const articles = tsv
        .split("\n")
        .map(parseGkgLine)
        .filter((a): a is GkgArticle => a !== null);

    const ms = Math.round(performance.now() - t0);
    console.log(
        `✅ [${label}] ${(zipBytes.byteLength / 1024 / 1024).toFixed(2)} MB ZIP -> ` +
        `${articles.length} artículos web parseados en ${ms} ms\n`
    );
    return articles;
}

// ---------- Ejecución principal ----------

const [translatedRes, englishRes] = await Promise.allSettled([
    fetchGkgBatch(FEEDS.translated, "65 Idiomas"),
    fetchGkgBatch(FEEDS.english, "Inglés"),
]);

const translated = translatedRes.status === "fulfilled" ? translatedRes.value : [];
const english = englishRes.status === "fulfilled" ? englishRes.value : [];

if (translatedRes.status === "rejected") console.error("❌ Fallo en 65 Idiomas:", translatedRes.reason);
if (englishRes.status === "rejected") console.error("❌ Fallo en Inglés:", englishRes.reason);

// 1. Artículos en español
const spanish = translated.filter((a) => a.language === "spa" && a.title);
console.log(`🇪🇸 Artículos en español en la oleada: ${spanish.length}`);
for (const art of spanish.slice(0, 8)) {
    console.log(`  - [${art.domain}] ${art.title}`);
    console.log(`    Temas: ${art.themes.slice(0, 4).join(", ") || "—"} | Lugares: ${art.locations.slice(0, 3).join(", ") || "—"}`);
    console.log(`    URL: ${art.url}`);
}

// 2. Ciberseguridad global (inglés + traducidos)
const all = [...english, ...translated];
const cyber = all.filter((a) =>
    a.title && a.themes.some((t) => t.includes("CYBER_ATTACK") || t.includes("RANSOMWARE") || t.includes("DATA_BREACH"))
);

console.log(`\n🛡️ Artículos de ciberseguridad en los últimos 15 min (global): ${cyber.length}`);
for (const art of cyber.slice(0, 8)) {
    console.log(`  - [${art.language} | ${art.domain}] ${art.title}`);
    console.log(`    Organizaciones: ${art.organizations.slice(0, 3).join(", ") || "—"}`);
    console.log(`    URL: ${art.url}`);
}