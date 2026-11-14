import { createCategory } from "./categories";
import { db } from "./db";
import { createSource } from "./sources";

// Algunas URLs pueden cambiar con el tiempo: el dashboard muestra el error de cada fuente.
const rss = (name: string, url: string) => ({ name, type: "rss" as const, url });
const gdelt = (name: string, query: string) => ({ name, type: "gdelt" as const, url: query });

const DEFAULT_SOURCES = [
    rss("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    rss("BBC Middle East", "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml"),
    rss("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
    rss("The Guardian World", "https://www.theguardian.com/world/rss"),
    rss("NYT World", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
    rss("DW Español", "https://rss.dw.com/xml/rss-sp-all"),
    rss("France 24 ES", "https://www.france24.com/es/rss"),
    rss("UN News", "https://news.un.org/feed/subscribe/en/news/all/rss.xml"),
    rss("IAEA", "https://www.iaea.org/feeds/topnews"),
    rss("ReliefWeb", "https://reliefweb.int/updates/rss.xml"),
    rss("Defense One", "https://www.defenseone.com/rss/all/"),
    rss("Breaking Defense", "https://breakingdefense.com/feed/"),
    rss("USNI News", "https://news.usni.org/feed"),
    rss("War on the Rocks", "https://warontherocks.com/feed/"),
    rss("Bellingcat", "https://www.bellingcat.com/feed/"),
    rss("Crisis Group", "https://www.crisisgroup.org/rss.xml"),
    rss("BleepingComputer", "https://www.bleepingcomputer.com/feed/"),
    rss("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"),
    rss("MIT Technology Review", "https://www.technologyreview.com/feed/"),
    rss("Nature", "https://www.nature.com/nature.rss"),
    gdelt("GDELT · Conflicto y defensa", '(missile OR airstrike OR "air defense" OR drone) sourcelang:english'),
    gdelt("GDELT · Ciber", '(cyberattack OR ransomware OR "data breach") sourcelang:english'),
];

const DEFAULT_CATEGORIES = [
    {
        name: "Conflictos armados",
        description: "Guerras, combates, bombardeos, ofensivas y operaciones militares entre estados o grupos armados.",
        examples: [
            "Russian forces launch offensive near Pokrovsk",
            "Israeli airstrikes hit targets in southern Lebanon",
            "Houthi missile attack on commercial vessel in the Red Sea",
        ],
    },
    {
        name: "Defensa y armamento",
        description: "Programas de armamento, compras militares, industria de defensa, sistemas de armas y presupuestos de defensa.",
        examples: [
            "Pentagon awards contract for new fighter jet engines",
            "Alemania aumenta su presupuesto de defensa y compra tanques",
            "Navy deploys carrier strike group to the Pacific",
        ],
    },
    {
        name: "Nuclear y misiles",
        description: "Programas nucleares, enriquecimiento de uranio, pruebas de misiles balísticos, proliferación y control de armamento.",
        examples: [
            "IAEA reports Iran increased enriched uranium stockpile",
            "North Korea tests new intercontinental ballistic missile",
            "Nuevo tratado de control de armas nucleares",
        ],
    },
    {
        name: "Ciberseguridad",
        description: "Ciberataques, ransomware, vulnerabilidades críticas, espionaje digital y operaciones cibernéticas estatales.",
        examples: [
            "Ransomware gang claims attack on hospital network",
            "State-sponsored hackers exploit zero-day vulnerability",
            "Filtración masiva de datos de millones de usuarios",
        ],
    },
    {
        name: "Inteligencia artificial",
        description: "Modelos de IA, empresas de IA, investigación en aprendizaje automático y regulación de la inteligencia artificial.",
        examples: [
            "OpenAI releases new reasoning model",
            "La UE aprueba nuevas normas para sistemas de IA de alto riesgo",
            "Researchers show large language models can plan multi-step tasks",
        ],
    },
    {
        name: "Semiconductores y tecnología estratégica",
        description: "Chips, fabricación de semiconductores, controles de exportación tecnológica, computación cuántica y satélites.",
        examples: [
            "US tightens export controls on advanced AI chips to China",
            "TSMC begins production at new fab",
            "Lanzamiento de una constelación de satélites militares",
        ],
    },
    {
        name: "Energía y materias primas",
        description: "Petróleo, gas, electricidad, minerales críticos, tierras raras, precios de materias primas y seguridad energética.",
        examples: [
            "Brent crude jumps as OPEC+ extends output cuts",
            "China restringe la exportación de tierras raras",
            "Europe's gas storage levels ahead of winter",
        ],
    },
    {
        name: "Rutas marítimas y comercio",
        description: "Estrechos y canales estratégicos, transporte marítimo, aranceles, cadenas de suministro y comercio internacional.",
        examples: [
            "Shipping firms reroute vessels around Cape of Good Hope",
            "Estados Unidos impone nuevos aranceles a importaciones chinas",
            "Tanker traffic through the Strait of Hormuz disrupted",
        ],
    },
    {
        name: "Diplomacia y sanciones",
        description: "Negociaciones, cumbres, tratados, altos el fuego, sanciones y relaciones entre gobiernos.",
        examples: [
            "Ceasefire talks resume in Doha with mediators",
            "EU adopts new sanctions package against Russia",
            "Cumbre bilateral entre los presidentes de China y Estados Unidos",
        ],
    },
    {
        name: "Crisis humanitarias",
        description: "Víctimas civiles, desplazados, hambrunas, ayuda humanitaria, desastres naturales y emergencias sanitarias.",
        examples: [
            "UN warns of famine as aid trucks blocked at border",
            "Terremoto deja cientos de muertos y miles de desplazados",
            "Cholera outbreak spreads in refugee camps",
        ],
    },
    {
        name: "Ciencia",
        description: "Descubrimientos científicos, investigación publicada, biología, física, clima, medicina y exploración espacial.",
        examples: [
            "Scientists discover new class of antibiotics",
            "James Webb telescope detects atmosphere on distant exoplanet",
            "Un estudio publicado en Nature revela nuevos datos sobre el cambio climático",
        ],
    },
];

const isEmpty = (table: string): boolean =>
    db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n === 0;

/** Rellena fuentes y categorías de ejemplo solo la primera vez. */
export function seedDefaults(): void {
    if (isEmpty("sources")) {
        for (const source of DEFAULT_SOURCES) createSource({ ...source, interval_minutes: 30, enabled: 1 });
    }
    if (isEmpty("categories")) {
        for (const category of DEFAULT_CATEGORIES) {
            createCategory({ ...category, examples: category.examples.join("\n"), threshold: 0.6, enabled: 1 });
        }
    }
}