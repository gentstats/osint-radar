export const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
    return chunks;
}

export function stripHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Quita el fragmento y los parámetros utm_* para detectar mejor los duplicados. */
export function canonicalUrl(raw: string): string {
    try {
        const url = new URL(raw);
        url.hash = "";
        for (const key of [...url.searchParams.keys()]) {
            if (key.startsWith("utm_")) url.searchParams.delete(key);
        }
        return url.toString();
    } catch {
        return raw;
    }
}