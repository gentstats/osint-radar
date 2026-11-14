import { db, updateRow } from "./db";
import { geminiConfigured, embedTexts } from "./gemini";
import type { CategoryInput, CategoryPatch } from "./schemas";
import type { Category } from "./types";
import { dot, fromBlob, toBlob } from "./vectors";

const MAX_CATEGORIES_PER_ARTICLE = 3;

export interface CategoryPrototype {
    categoryId: number;
    threshold: number;
    vector: Float32Array;
}

export interface CategoryScore {
    categoryId: number;
    score: number;
}

// ---------- CRUD ----------

export const listCategories = (): Category[] =>
    db.query<Category, []>("SELECT * FROM categories ORDER BY name").all();

export const getCategory = (id: number): Category | null =>
    db.query<Category, [number]>("SELECT * FROM categories WHERE id = ?").get(id);

export function createCategory(input: CategoryInput): Category {
    const { lastInsertRowid } = db
        .query("INSERT INTO categories (name, description, examples, threshold, enabled) VALUES (?, ?, ?, ?, ?)")
        .run(input.name, input.description, input.examples, input.threshold, input.enabled);
    return getCategory(Number(lastInsertRowid))!;
}

export function updateCategory(id: number, patch: CategoryPatch): Category | null {
    updateRow("categories", id, patch);
    const textChanged = patch.description !== undefined || patch.examples !== undefined;
    if (textChanged) db.query("DELETE FROM category_vectors WHERE category_id = ?").run(id);
    return getCategory(id);
}

export const deleteCategory = (id: number): boolean =>
    db.query("DELETE FROM categories WHERE id = ?").run(id).changes > 0;

// ---------- Prototipos (los vectores que definen cada categoría) ----------

const prototypeTexts = (category: Category): string[] => [
    `${category.name}: ${category.description}`,
    ...category.examples.split("\n").map((line) => line.trim()).filter(Boolean),
];

/** Calcula los vectores de las categorías activas que todavía no los tienen. */
export async function ensureCategoryVectors(): Promise<void> {
    if (!geminiConfigured()) return;

    const missing = db
        .query<Category, []>(
            `SELECT * FROM categories
       WHERE enabled = 1 AND id NOT IN (SELECT category_id FROM category_vectors)`,
        )
        .all();

    for (const category of missing) {
        const texts = prototypeTexts(category);
        const vectors = await embedTexts(texts);
        const insert = db.query("INSERT INTO category_vectors (category_id, text, embedding) VALUES (?, ?, ?)");
        db.transaction(() => {
            vectors.forEach((vector, i) => insert.run(category.id, texts[i], toBlob(vector)));
        })();
    }
}

export function loadPrototypes(): CategoryPrototype[] {
    return db
        .query<{ category_id: number; threshold: number; embedding: Uint8Array }, []>(
            `SELECT v.category_id, c.threshold, v.embedding
       FROM category_vectors v JOIN categories c ON c.id = v.category_id
       WHERE c.enabled = 1`,
        )
        .all()
        .map((row) => ({
            categoryId: row.category_id,
            threshold: row.threshold,
            vector: fromBlob(row.embedding),
        }));
}

// ---------- Clasificación ----------

/** Puntúa cada categoría con su prototipo más parecido y conserva las que superan su umbral. */
export function classify(embedding: Float32Array, prototypes: CategoryPrototype[]): CategoryScore[] {
    const best = new Map<number, { score: number; threshold: number }>();

    for (const prototype of prototypes) {
        const score = dot(embedding, prototype.vector);
        const current = best.get(prototype.categoryId);
        if (!current || score > current.score) {
            best.set(prototype.categoryId, { score, threshold: prototype.threshold });
        }
    }

    return [...best]
        .filter(([, { score, threshold }]) => score >= threshold)
        .map(([categoryId, { score }]) => ({ categoryId, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CATEGORIES_PER_ARTICLE);
}

export function saveClassification(articleId: number, scores: CategoryScore[]): void {
    db.query("DELETE FROM article_categories WHERE article_id = ?").run(articleId);
    const insert = db.query("INSERT INTO article_categories (article_id, category_id, score) VALUES (?, ?, ?)");
    for (const { categoryId, score } of scores) insert.run(articleId, categoryId, score);
}