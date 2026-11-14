import { createCategory } from "./categories";
import { db } from "./db";
import { createSource } from "./sources";

// Algunas URLs pueden cambiar con el tiempo: el dashboard muestra el error de cada fuente y permite editarlas.
const rss = (name: string, url: string) => ({ name, type: "rss" as const, url });
const gdelt = (name: string, query: string) => ({ name, type: "gdelt" as const, url: query });

const DEFAULT_SOURCES = [
    // Noticias globales y geopolítica regional
    rss("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    rss("BBC Middle East", "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml"),
    rss("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
    rss("The Guardian World", "https://www.theguardian.com/world/rss"),
    rss("NYT World", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
    rss("DW Español", "https://rss.dw.com/xml/rss-sp-all"),
    rss("France 24 ES", "https://www.france24.com/es/rss"),
    rss("EL PAÍS Internacional", "https://elpais.com/rss/internacional/portada.xml"),
    rss("POLITICO Europe", "https://www.politico.eu/feed/"),
    rss("Middle East Eye", "https://www.middleeasteye.net/rss"),
    rss("The Diplomat", "https://thediplomat.com/feed/"),
    rss("South China Morning Post", "https://www.scmp.com/rss/91/feed"),
    rss("The Moscow Times", "https://www.themoscowtimes.com/rss/news"),
    rss("Meduza (EN)", "https://meduza.io/rss/en/all"),
    rss("Euromaidan Press", "https://euromaidanpress.com/feed/"),
    rss("Africanews", "https://www.africanews.com/feed/rss"),
    rss("MercoPress", "https://en.mercopress.com/rss/"),

    // Crisis humanitarias, organismos y desastres
    rss("UN News", "https://news.un.org/feed/subscribe/en/news/all/rss.xml"),
    rss("GDACS (Desastres ONU/UE)", "https://www.gdacs.org/xml/rss.xml"),
    rss("WHO News", "https://www.who.int/rss-feeds/news-english.xml"),
    rss("ICRC Law & Policy", "https://blogs.icrc.org/law-and-policy/feed/"),

    // Defensa, conflictos, OSINT y nuclear
    rss("Defense One", "https://www.defenseone.com/rss/all/"),
    rss("Breaking Defense", "https://breakingdefense.com/feed/"),
    rss("USNI News", "https://news.usni.org/feed"),
    rss("War on the Rocks", "https://warontherocks.com/feed/"),
    rss("TWZ (The War Zone)", "https://www.twz.com/feed"),
    rss("Bellingcat", "https://www.bellingcat.com/feed/"),
    rss("Crisis Group", "https://www.crisisgroup.org/rss.xml"),
    rss("Foreign Policy", "https://foreignpolicy.com/feed/"),
    rss("IAEA", "https://www.iaea.org/feeds/topnews"),
    rss("38 North", "https://www.38north.org/feed/"),

    // Ciberseguridad
    rss("BleepingComputer", "https://www.bleepingcomputer.com/feed/"),
    rss("The Hacker News", "https://feeds.feedburner.com/TheHackersNews"),
    rss("The Record (Recorded Future)", "https://therecord.media/feed/"),
    rss("Krebs on Security", "https://krebsonsecurity.com/feed/"),
    rss("CISA Advisories", "https://www.cisa.gov/cybersecurity-advisories/all.xml"),

    // IA, semiconductores y tecnología estratégica
    rss("Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"),
    rss("MIT Technology Review", "https://www.technologyreview.com/feed/"),
    rss("OpenAI News", "https://openai.com/news/rss.xml"),
    rss("Hugging Face Blog", "https://huggingface.co/blog/feed.xml"),
    rss("Tom's Hardware", "https://www.tomshardware.com/feeds/all"),
    rss("Semiconductor Engineering", "https://semiengineering.com/feed/"),
    rss("SpaceNews", "https://spacenews.com/feed/"),

    // Energía, materias primas y rutas marítimas
    rss("OilPrice", "https://oilprice.com/rss/main"),
    rss("MINING.com", "https://www.mining.com/feed/"),
    rss("EIA Today in Energy", "https://www.eia.gov/rss/todayinenergy.xml"),
    rss("gCaptain", "https://gcaptain.com/feed/"),
    rss("The Maritime Executive", "https://maritime-executive.com/articles.rss"),
    rss("Splash247", "https://splash247.com/feed/"),

    // Ciencia
    rss("Nature", "https://www.nature.com/nature.rss"),
    rss("Quanta Magazine", "https://www.quantamagazine.org/feed/"),
    rss("Phys.org", "https://phys.org/rss-feed/"),
    rss("ESA Top News", "https://www.esa.int/rssfeed/TopNews"),

    // GDELT
    gdelt("GDELT · Conflicto y defensa", '(missile OR airstrike OR "air defense" OR drone) sourcelang:english'),
    gdelt("GDELT · Ciber", '(cyberattack OR ransomware OR "data breach") sourcelang:english'),
    gdelt("GDELT · Energía y rutas marítimas", '("Strait of Hormuz" OR "Red Sea" OR "oil tanker" OR "rare earths" OR OPEC) sourcelang:english'),
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

/** Añade solo las fuentes recomendadas cuya URL/consulta no exista aún en la base de datos. */
export function seedMissingSources(): number {
    const existing = new Set(
        db.query<{ url: string }, []>("SELECT url FROM sources").all().map((row) => row.url),
    );
    let added = 0;
    for (const source of DEFAULT_SOURCES) {
        if (existing.has(source.url)) continue;
        createSource({ ...source, interval_minutes: 30, enabled: 1 });
        added++;
    }
    return added;
}

/** Rellena fuentes y categorías de ejemplo solo la primera vez. */
export function seedDefaults(): void {
    if (isEmpty("sources")) seedMissingSources();
    if (isEmpty("categories")) {
        for (const category of DEFAULT_CATEGORIES) {
            createCategory({ ...category, examples: category.examples.join("\n"), threshold: 0.6, enabled: 1 });
        }
    }
}