/** Escala el vector a norma 1: así el producto escalar equivale a la similitud coseno. */
export function normalize(values: ArrayLike<number>): Float32Array {
    const vector = Float32Array.from(values);
    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
    for (let i = 0; i < vector.length; i++) vector[i] /= norm;
    return vector;
}

export function dot(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return 0;
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}

/** Nuevo centroide al añadir `vector` a un grupo de `count` vectores. */
export function blend(centroid: Float32Array, count: number, vector: Float32Array): Float32Array {
    const sum = new Float32Array(centroid.length);
    for (let i = 0; i < sum.length; i++) sum[i] = centroid[i] * count + vector[i];
    return normalize(sum);
}

export const toBlob = (vector: Float32Array): Uint8Array =>
    new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);

export function fromBlob(blob: Uint8Array): Float32Array {
    return new Float32Array(blob.slice().buffer); // copia alineada a 4 bytes
}