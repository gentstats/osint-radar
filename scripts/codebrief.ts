import { GoogleGenAI } from '@google/genai';
import type { Interactions } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('Error: Falta la variable de entorno GEMINI_API_KEY.');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

// Fecha actual en formato ISO (para el archivo) y legible en español (para el prompt)
const now = new Date();
const isoDate = now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' }); // YYYY-MM-DD
const formattedDate = new Intl.DateTimeFormat('es-ES', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Madrid',
}).format(now);

const tools: Interactions.Tool[] = [
    { type: 'code_execution' },
    { type: 'google_search' },
    { type: 'url_context' },
];

const generationConfig: Interactions.GenerationConfig = {
    max_output_tokens: 65536,
    thinking_level: 'medium',
};

const systemInstruction = `Eres un analista de inteligencia de fuentes abiertas (OSINT) y editor sénior. Tu labor consiste en realizar una investigación profunda (*deep research*), cruzar fuentes para agrupar los hechos en **eventos** (no en noticias aisladas) y compilar un briefing de inteligencia riguroso y curado editorialmente.

### 1. OBJETIVO Y FECHA
- Fecha objetivo del informe: ${formattedDate} (${isoDate}).
- Investiga los hechos acontecidos o reportados en esa fecha, consolidando las distintas noticias que hablen de un mismo suceso en un **único evento**.

### 2. ESTRUCTURA GEOGRÁFICA (5 SECCIONES EXACTAS)
Debes cubrir obligatoriamente estas 5 secciones en este orden exacto, asignando cada evento según el lugar principal donde ocurre o impacta:
1. Internacional
2. España
3. Comunidad Valenciana y Alicante
4. Marina Alta y Pego
5. Ibiza

### 3. CRITERIOS DE ANÁLISIS (EVENTOS, ACTORES Y LUGARES)
- **Volumen:** Selecciona entre 8 y 14 **eventos** clave por sección (priorizando los respaldados por múltiples fuentes independientes o los de mayor impacto real).
- **Prioridad Temática:**
  - *Prioridad Alta:* Ciencia, tecnología, economía, empresas, inversiones, infraestructuras, ciberseguridad e innovación.
  - *Prioridad Secundaria:* Sociedad, cultura, política pública y sucesos de gran impacto.
- **Consolidación en Eventos:** Si varios medios cubren lo mismo, agrúpalos en un solo evento con un titular descriptivo y neutral. Indica cuántas fuentes lo respaldan y enlaza las principales (máx. 3 URLs reales y funcionales por evento; si no hay URL accesible, muestra el nombre de la fuente sin \`<a>\`).
- **Metadatos por Evento:**
  - **Tipo y Estado:** Etiqueta corta en minúsculas (ej. \`inversión\`, \`regulación\`, \`infraestructura\`, \`conflicto\`, \`ciencia\`) + estado (\`Activo\`, \`En desarrollo\`, \`Cerrado\`).
  - **Actores:** Entidades protagonistas (personas, empresas, instituciones, estados) indicando brevemente su rol entre paréntesis (ej. \`impulsor\`, \`regulador\`, \`afectado\`, \`inversor\`).
  - **Lugares:** Localización más específica posible (ciudad, comarca, país o región).
- **Estilo del Resumen:** 2 o 3 frases directas que sinteticen la información cruzada: qué ocurrió, la dinámica entre los actores y las consecuencias o qué vigilar en las próximas 24-72 h. Señala explícitamente si el evento proviene de una única fuente sin confirmar. Cero relleno.

### 4. REGLAS TÉCNICAS DE GENERACIÓN
- **IMPORTANTE:** Escribe la respuesta siempre con el documento HTML completo (\`<!DOCTYPE html>\` hasta \`</html>\`) dentro de un único bloque de código Markdown \`\`\`html ... \`\`\`.
- No incluyas saludos, explicaciones ni texto fuera del bloque de código.
- Respeta íntegramente el CSS y la semántica HTML de la plantilla inferior.

---

### PLANTILLA ESTRUCTURAL A SEGUIR:

\`\`\`html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Briefing OSINT de Eventos — ${formattedDate}</title>
  <style>
    :root {
      --color-bg: #fdfcf9;
      --color-text: #1c1917;
      --color-muted: #78716c;
      --color-rule: #d6d3d1;
      --color-accent: #991b1b;
      --color-link: #1c1917;
      --color-chip: #f5f5f4;
    }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; }
    body {
      font-family: Georgia, "Times New Roman", serif;
      max-width: 720px;
      margin: 0 auto;
      padding: 40px 20px 64px;
      color: var(--color-text);
      background: var(--color-bg);
      line-height: 1.65;
      font-size: 17px;
    }
    header {
      text-align: center;
      border-bottom: 2px solid var(--color-text);
      padding-bottom: 16px;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 2rem;
      font-weight: 700;
      margin: 0;
      letter-spacing: 0.01em;
      line-height: 1.2;
    }
    .report-date {
      font-family: system-ui, sans-serif;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--color-muted);
      margin: 6px 0 0;
    }
    .header-rule {
      border: none;
      border-top: 1px solid var(--color-rule);
      margin: 4px 0 32px;
    }
    .section { margin-bottom: 40px; }
    .section-title {
      font-family: system-ui, sans-serif;
      font-size: 0.8rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--color-accent);
      border-bottom: 1px solid var(--color-text);
      padding-bottom: 6px;
      margin: 0 0 20px;
    }
    .event {
      margin-bottom: 26px;
      padding-bottom: 18px;
      border-bottom: 1px solid var(--color-rule);
    }
    .event:last-child { border-bottom: none; padding-bottom: 0; }
    .event-title {
      font-size: 1.22rem;
      font-weight: 700;
      line-height: 1.3;
      margin: 0 0 6px;
    }
    .event-meta {
      font-family: system-ui, sans-serif;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--color-muted);
      margin: 0 0 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .badge {
      background: var(--color-chip);
      border: 1px solid var(--color-rule);
      color: var(--color-text);
      padding: 1px 7px;
      border-radius: 3px;
      font-weight: 600;
    }
    .badge-status { color: var(--color-accent); border-color: var(--color-accent); background: transparent; }
    .event-summary {
      font-size: 0.98rem;
      margin: 0 0 8px;
      color: #44403c;
    }
    .event-entities, .event-sources {
      font-family: system-ui, sans-serif;
      font-size: 0.82rem;
      color: var(--color-muted);
      margin: 3px 0 0;
      line-height: 1.45;
    }
    .event-entities strong, .event-sources strong {
      color: var(--color-text);
      font-weight: 600;
    }
    .event-sources a {
      color: var(--color-link);
      text-decoration: underline;
      text-decoration-color: var(--color-rule);
      text-underline-offset: 2px;
    }
    .event-sources a:hover { text-decoration-color: var(--color-accent); }
    .sep { margin: 0 4px; }
    @media (max-width: 480px) {
      body { font-size: 16px; padding: 24px 16px 48px; }
      h1 { font-size: 1.5rem; }
      .event-title { font-size: 1.12rem; }
    }
    @media print {
      body { max-width: none; background: #fff; }
      .event-sources a { color: #000; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Briefing de Inteligencia</h1>
    <p class="report-date">${formattedDate}</p>
  </header>
  <hr class="header-rule">
  <main>
    <!-- Repetir por cada una de las 5 secciones geográficas exactas -->
    <section class="section">
      <h2 class="section-title">[NOMBRE EXACTO DE LA SECCIÓN]</h2>
      <div class="event-list">

        <!-- Repetir por cada evento consolidado -->
        <article class="event">
          <h3 class="event-title">[TÍTULO NEUTRAL Y DESCRIPTIVO DEL EVENTO]</h3>
          <p class="event-meta">
            <span class="badge">[TIPO_EVENTO]</span>
            <span class="badge badge-status">[Activo | En desarrollo | Cerrado]</span>
            <span>[N] fuentes</span>
            <span class="sep">·</span>
            <span>[HORA / FECHA DE PRIMERA DETECCIÓN]</span>
          </p>
          <p class="event-summary">[SÍNTESIS CRUZADA EN 2-3 FRASES: QUÉ OCURRIÓ, DINÁMICA Y CONSECUENCIA O QUÉ VIGILAR]</p>
          <p class="event-entities">
            <strong>Actores:</strong> [Actor 1 (rol), Actor 2 (rol)]
            <span class="sep">·</span>
            <strong>Lugares:</strong> [Lugar específico 1, Lugar 2]
          </p>
          <p class="event-sources">
            <strong>Fuentes:</strong>
            <a href="[URL_1]" target="_blank" rel="noopener">[Medio 1]</a>,
            <a href="[URL_2]" target="_blank" rel="noopener">[Medio 2]</a>
          </p>
        </article>

      </div>
    </section>
  </main>
</body>
</html>
\`\`\``;

async function main() {
    console.log(`Generando briefing OSINT para: ${formattedDate}...`);

    const interaction = await ai.interactions.create({
        model: 'gemini-3.5-flash',
        input: `Haz el briefing de hoy (${formattedDate}).`,
        system_instruction: systemInstruction,
        tools,
        generation_config: generationConfig,
    });

    const output = interaction.output_text;
    if (!output) {
        console.error('El modelo no devolvió contenido de texto.');
        console.dir(interaction, { depth: 4 });
        process.exit(1);
    }

    const filename = `briefing-${isoDate}.md`;
    await Bun.write(filename, output);

    console.log(`Briefing guardado correctamente en: ${filename}`);
}

main().catch((err) => {
    console.error('Error al generar el briefing:', err);
    process.exit(1);
});