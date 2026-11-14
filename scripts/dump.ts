import { Glob } from "bun";

const DEFAULT_OUTPUT = "project-dump.md";

/**
 * Qué entra en el volcado. El `.env` real NO está en la lista a propósito:
 * contiene claves secretas y nunca debe acabar en un archivo que se comparte.
 */
const INCLUDE_PATTERNS = [
    "package.json",
    "tsconfig.json",
    ".env.example",
    ".gitignore",
    "README.md",
    "dashboard.html",
    "src/**/*.ts",
    "scripts/**/*.ts",
];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
    ts: "ts",
    json: "json",
    html: "html",
    md: "md",
};

const output = Bun.argv[2] ?? DEFAULT_OUTPUT;

async function collectFiles(): Promise<string[]> {
    const files = new Set<string>();
    for (const pattern of INCLUDE_PATTERNS) {
        for await (const path of new Glob(pattern).scan({ dot: true })) files.add(path);
    }
    files.delete(output);
    return [...files].sort();
}

function languageOf(path: string): string {
    const extension = path.split(".").pop() ?? "";
    return LANGUAGE_BY_EXTENSION[extension] ?? "";
}

/** Usa una valla más larga que cualquier racha de ``` del contenido (el README las contiene). */
function fenceFor(content: string): string {
    const longestRun = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
    return "`".repeat(Math.max(3, longestRun + 1));
}

async function renderFile(path: string): Promise<string> {
    const content = (await Bun.file(path).text()).trimEnd();
    const fence = fenceFor(content);
    return `## ${path}\n\n${fence}${languageOf(path)}\n${content}\n${fence}`;
}

function renderHeader(files: string[]): string {
    const generatedAt = new Date().toISOString();
    const index = files.map((file) => `- ${file}`).join("\n");
    return `# Volcado del proyecto\n\nGenerado: ${generatedAt} · ${files.length} archivos\n\n${index}`;
}

const files = await collectFiles();
const sections = await Promise.all(files.map(renderFile));
await Bun.write(output, [renderHeader(files), ...sections].join("\n\n") + "\n");

console.log(`✔ ${files.length} archivos volcados en ${output}`);