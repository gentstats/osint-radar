const USER_AGENT = "OsintRadar/1.0 (self-hosted)";
const NOMINATIM_PAUSE_MS = 1_100; // la política de uso pide como máximo 1 petición por segundo

export interface GeoResult {
    lat: number;
    lon: number;
    countryCode: string | null;
}

type Search = (name: string, countryCode: string | null) => Promise<GeoResult | null>;

async function getJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
        headers: { "user-agent": USER_AGENT, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
}

/** Open-Meteo: gratuito y sin clave. Bueno para países, regiones y ciudades. */
const searchOpenMeteo: Search = async (name, countryCode) => {
    const params = new URLSearchParams({ name, count: "1", language: "en", format: "json" });
    if (countryCode) params.set("countryCode", countryCode);

    const data = await getJson<{ results?: { latitude: number; longitude: number; country_code?: string }[] }>(
        `https://geocoding-api.open-meteo.com/v1/search?${params}`,
    );
    const hit = data.results?.[0];
    return hit ? { lat: hit.latitude, lon: hit.longitude, countryCode: hit.country_code ?? null } : null;
};

let lastNominatimAt = 0;

/** Nominatim (OpenStreetMap): cubre mares, estrechos e instalaciones que Open-Meteo no conoce. */
const searchNominatim: Search = async (name, countryCode) => {
    const wait = lastNominatimAt + NOMINATIM_PAUSE_MS - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    lastNominatimAt = Date.now();

    const params = new URLSearchParams({ q: name, format: "jsonv2", limit: "1", addressdetails: "1" });
    if (countryCode) params.set("countrycodes", countryCode.toLowerCase());

    const data = await getJson<{ lat: string; lon: string; address?: { country_code?: string } }[]>(
        `https://nominatim.openstreetmap.org/search?${params}`,
    );
    const hit = data[0];
    if (!hit) return null;
    return {
        lat: Number(hit.lat),
        lon: Number(hit.lon),
        countryCode: hit.address?.country_code?.toUpperCase() ?? null,
    };
};

/**
 * Devuelve null si ningún servicio conoce el lugar.
 * Lanza solo si TODOS los servicios fallaron (red caída, bloqueo): en ese caso conviene reintentar luego.
 */
export async function geocode(name: string, countryCode: string | null): Promise<GeoResult | null> {
    let answered = false;
    let lastError: unknown;

    for (const search of [searchOpenMeteo, searchNominatim]) {
        try {
            const result = await search(name, countryCode);
            answered = true;
            if (result && Number.isFinite(result.lat) && Number.isFinite(result.lon)) return result;
        } catch (error) {
            lastError = error;
        }
    }
    if (!answered) throw lastError;
    return null;
}