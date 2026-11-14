import { EMBEDDING_DIMENSIONS, env } from "./config";
import { chunk } from "./utils";
import { normalize } from "./vectors";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const EMBEDDING_BATCH_LIMIT = 100;

export const geminiConfigured = (): boolean => env.geminiApiKey !== "";

interface GenerateResponse {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
}

async function callGemini<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
    const response = await fetch(`${API_ROOT}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.geminiApiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new Error(`Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return (await response.json()) as T;
}

function responseText(data: GenerateResponse): string {
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
    if (!text) throw new Error("Gemini no devolvió texto");
    return text;
}

/** Devuelve un vector normalizado por texto, en el mismo orden. */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
    const model = `models/${env.embeddingModel}`;
    const vectors: Float32Array[] = [];

    for (const batch of chunk(texts, EMBEDDING_BATCH_LIMIT)) {
        const { embeddings } = await callGemini<{ embeddings: { values: number[] }[] }>(
            `${model}:batchEmbedContents`,
            {
                requests: batch.map((text) => ({
                    model,
                    content: { parts: [{ text }] },
                    taskType: "SEMANTIC_SIMILARITY",
                    outputDimensionality: EMBEDDING_DIMENSIONS,
                })),
            },
            30_000,
        );
        vectors.push(...embeddings.map((embedding) => normalize(embedding.values)));
    }
    return vectors;
}

export async function generateText(prompt: string): Promise<string> {
    const data = await callGemini<GenerateResponse>(
        `models/${env.digestModel}:generateContent`,
        { contents: [{ parts: [{ text: prompt }] }] },
        60_000,
    );
    return responseText(data);
}

/**
 * Salida estructurada: Gemini devuelve JSON que cumple `responseSchema`
 * y `parse` (normalmente zod) lo valida antes de que llegue al resto del código.
 */
export async function generateJson<T>(
    prompt: string,
    responseSchema: object,
    parse: (raw: unknown) => T,
): Promise<T> {
    const data = await callGemini<GenerateResponse>(
        `models/${env.extractionModel}:generateContent`,
        {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0.1 },
        },
        90_000,
    );

    let raw: unknown;
    try {
        raw = JSON.parse(responseText(data));
    } catch {
        throw new Error("Gemini devolvió un JSON no válido (¿respuesta truncada?)");
    }
    return parse(raw);
}