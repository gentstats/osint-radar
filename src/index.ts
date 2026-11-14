import { join } from "node:path";
import { Hono, type Context } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import {
  createCategory,
  deleteCategory,
  ensureCategoryVectors,
  listCategories,
  updateCategory,
} from "./categories";
import { env } from "./config";
import { generateDigest, getLatestDigest } from "./digest";
import { ingestSource } from "./ingest";
import { reclassifyStoredArticles, resetForReembedding, runPipeline } from "./pipeline";
import {
  getCategoryTrends,
  getEventArticles,
  getOverview,
  getTopEvents,
  listArticles,
} from "./queries";
import { listRuns } from "./runs";
import { categoryPatchSchema, categorySchema, settingsSchema, sourcePatchSchema, sourceSchema } from "./schemas";
import { seedDefaults } from "./seed";
import { startScheduler } from "./scheduler";
import { getSettings, updateSettings } from "./settings";
import { createSource, deleteSource, getSource, listSources, updateSource } from "./sources";
import { errorMessage } from "./utils"

const DASHBOARD_PATH = join(import.meta.dir, "..", "dashboard.html");

// ---------- Helpers ----------

function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) throw new HTTPException(400, { message: "Id no válido" });
  return id;
}

function notFound(what: string): never {
  throw new HTTPException(404, { message: `${what} no encontrado` });
}

function numberQuery(c: Context, name: string, fallback: number, max: number): number {
  const value = Number(c.req.query(name));
  return Math.min(max, Math.max(0, Number.isFinite(value) && c.req.query(name) ? value : fallback));
}

// ---------- API ----------

const api = new Hono();

if (env.adminToken) api.use("*", bearerAuth({ token: env.adminToken }));
else console.warn("⚠️  ADMIN_TOKEN vacío: la API no tiene autenticación");

// Métricas y datos
api.get("/overview", (c) => c.json(getOverview()));
api.get("/trends", (c) => c.json(getCategoryTrends()));
api.get("/runs", (c) => c.json(listRuns()));
api.get("/events", (c) =>
  c.json(getTopEvents(numberQuery(c, "hours", 24, 720), numberQuery(c, "limit", 50, 200))),
);
api.get("/events/:id", (c) => c.json({ articles: getEventArticles(idParam(c)) }));
api.get("/articles", (c) =>
  c.json(
    listArticles({
      limit: numberQuery(c, "limit", 50, 200),
      offset: numberQuery(c, "offset", 0, 100_000),
      categoryId: Number(c.req.query("category")) || undefined,
      sourceId: Number(c.req.query("source")) || undefined,
      search: c.req.query("q")?.trim() || undefined,
    }),
  ),
);

// Fuentes
api.get("/sources", (c) => c.json(listSources()));
api.post("/sources", async (c) => c.json(createSource(sourceSchema.parse(await c.req.json())), 201));
api.patch("/sources/:id", async (c) => {
  const source = updateSource(idParam(c), sourcePatchSchema.parse(await c.req.json()));
  return c.json(source ?? notFound("Fuente"));
});
api.delete("/sources/:id", (c) => (deleteSource(idParam(c)) ? c.json({ ok: true }) : notFound("Fuente")));
api.post("/sources/:id/fetch", async (c) => {
  const source = getSource(idParam(c)) ?? notFound("Fuente");
  return c.json({ added: await ingestSource(source) });
});

// Categorías
api.get("/categories", (c) => c.json(listCategories()));
api.post("/categories", async (c) => {
  const category = createCategory(categorySchema.parse(await c.req.json()));
  await ensureCategoryVectors().catch(console.error); // si falla, el planificador lo reintenta
  return c.json(category, 201);
});
api.patch("/categories/:id", async (c) => {
  const category = updateCategory(idParam(c), categoryPatchSchema.parse(await c.req.json()));
  await ensureCategoryVectors().catch(console.error);
  return c.json(category ?? notFound("Categoría"));
});
api.delete("/categories/:id", (c) =>
  deleteCategory(idParam(c)) ? c.json({ ok: true }) : notFound("Categoría"),
);

// Ajustes
api.get("/settings", (c) => c.json(getSettings()));
api.put("/settings", async (c) => c.json(updateSettings(settingsSchema.parse(await c.req.json()))));

// Pipeline
api.post("/pipeline/run", async (c) => c.json(await runPipeline({ force: true })));
api.post("/pipeline/reclassify", async (c) => c.json(await reclassifyStoredArticles()));
api.post("/pipeline/reembed", (c) => {
  resetForReembedding();
  return c.json({ ok: true });
});

// Briefing
api.get("/digest", (c) => c.json(getLatestDigest()));
api.post("/digest", async (c) => c.json({ content: await generateDigest() }));

// ---------- App ----------

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.get("/", (c) => c.redirect("/dashboard"));
app.get("/dashboard", async (c) => c.html(await Bun.file(DASHBOARD_PATH).text()));
app.route("/api", api);
app.get("/favicon.ico", (c) => c.body(null, 204));

app.onError((error, c) => {
  if (error instanceof ZodError) {
    const message = error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    return c.json({ error: message }, 400);
  }
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  if (error.message.includes("UNIQUE constraint")) {
    return c.json({ error: "Ya existe un registro con ese valor" }, 409);
  }
  console.error(error);
  return c.json({ error: errorMessage(error) }, 500);
});

seedDefaults();
startScheduler();

export default { port: env.port, fetch: app.fetch, idleTimeout: 255 }; 