# Radar OSINT

Servidor que recopila noticias de fuentes abiertas (RSS y GDELT), las **clasifica por significado con embeddings**, las **agrupa en eventos** y **extrae de cada evento sus actores, lugares y coordenadas** con un LLM. Incluye un dashboard de administración con mapa.

Las categorías se definen en lenguaje natural desde el dashboard. Para pasar de inteligencia militar a ciencia o tecnología basta con crear categorías y fuentes nuevas, sin tocar código. Los actores, lugares, tipos de evento y roles no están hardcodeados: aparecen solos a medida que entran noticias.

## Características

- **Ingesta** de feeds RSS/Atom y consultas GDELT (con cola global de rate-limit), con intervalo configurable por fuente.
- **Clasificación semántica**: cada categoría es una descripción más titulares de ejemplo; los artículos se asignan por similitud coseno. Funciona entre idiomas.
- **Eventos**: los artículos que cuentan lo mismo se agrupan por similitud con el centroide del evento. Cada evento conoce cuándo salió su primera noticia y cuál es su **estado** (`activo`, `enfriándose`, `caducado`), calculado al consultar.
- **Enriquecimiento**: un LLM extrae por evento un título limpio, un resumen, un tipo, los **actores** (con rol) y los **lugares** implicados.
- **Entidades autogeneradas**: actores y lugares se fusionan entre menciones (alias + embeddings) y los lugares se geocodifican una sola vez.
- **Mapa** de eventos por localización con Mapbox GL JS.
- **Tendencias y anomalías** por categoría (z-score frente a la media de los días previos).
- **Briefing diario** redactado por un LLM a partir de los eventos de las últimas 24 h.
- **Persistencia** en un único archivo SQLite (`bun:sqlite`), sin servicios externos salvo Gemini, los geocodificadores y Mapbox (solo en la vista Mapa).

## Requisitos

- [Bun](https://bun.sh) 1.1 o superior.
- Una clave gratuita de Google AI Studio: https://aistudio.google.com
- Un token público de [Mapbox](https://www.mapbox.com/) (`pk.…`) si quieres usar la vista **Mapa** (el resto del dashboard funciona sin él).

## Puesta en marcha

```bash
bun install
cp .env.example .env     # rellena GEMINI_API_KEY, ADMIN_TOKEN y MAPBOX_TOKEN
bun run dev
```

Abre http://localhost:3000/dashboard. La primera vez pedirá el `ADMIN_TOKEN`.

Al arrancar por primera vez se crean fuentes y categorías de ejemplo. En unos minutos el planificador descarga artículos; también puedes pulsar **Ejecutar ciclo ahora** en el Resumen.

Las bases de datos anteriores se migran solas al arrancar (se añaden las columnas y tablas nuevas).

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `DATABASE_PATH` | `data/radar.sqlite` | Ruta del archivo SQLite |
| `ADMIN_TOKEN` | *(vacío)* | Protege la API. Solo letras, números y `._~+/-`. Vacío = API abierta |
| `GEMINI_API_KEY` | *(vacío)* | Sin ella se descargan artículos pero no se clasifican ni enriquecen |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | Modelo de embeddings |
| `DIGEST_MODEL` | `gemini-3.5-flash` | Modelo del briefing |
| `EXTRACTION_MODEL` | `gemini-3.5-flash` | Modelo que extrae actores, lugares y resúmenes |
| `MAPBOX_TOKEN` | *(vacío)* | Token público de Mapbox (`pk.…`) para la vista Mapa |

## Cómo funciona

```
 Fuentes (RSS / GDELT)
        │  cada minuto el planificador descarga las que toquen
        ▼
 articles (status = pending)
        │  embedding por artículo (Gemini)
        ▼
 ┌──────────────┬────────────────────────┐
 │ Clasificar   │ Agrupar en eventos     │
 │ coseno contra│ coseno contra el       │
 │ prototipos de│ centroide de eventos   │
 │ cada categoría│ activos               │
 └──────────────┴────────────────────────┘
        ▼
 events ──► Enriquecer (1 llamada al LLM por ~8 eventos)
              resumen · tipo · actores · lugares
        ▼
 Resolver entidades: alias exacto → similitud de embeddings → entidad nueva
        ▼
 Geocodificar lugares nuevos (Open-Meteo → Nominatim → coordenadas del LLM)
        ▼
 tendencias, eventos, entidades, mapa, briefing
```

- **Prototipos**: cada categoría tiene un vector por su descripción y uno por cada titular de ejemplo. Un artículo puntúa en una categoría con su prototipo más parecido, y se conserva si supera el umbral de esa categoría (máximo 3 categorías por artículo).
- **Embeddings guardados**: se almacenan junto al artículo, así que cambiar umbrales o categorías y pulsar **Reclasificar** no vuelve a llamar a la API.
- **Retención**: los artículos y eventos más antiguos que `retentionDays` se eliminan en cada ciclo. Las entidades sobreviven más (`entityRetentionDays`) y solo se borran si no tienen ningún evento.

### Estado de un evento

No se guarda: se deriva de la hora de la última noticia.

| Estado | Condición |
|---|---|
| `active` | El silencio es normal para el ritmo del evento: menos de `max(eventActiveMinHours, 3 × intervalo medio entre artículos)`, sin pasar de la ventana |
| `cooling` | Ha superado ese silencio, pero aún está dentro de `eventWindowHours` y podría reactivarse |
| `expired` | Lleva sin noticias más que `eventWindowHours`: ya no recibe artículos |

`first_seen_at` es la hora de publicación de la noticia más antigua del evento.

### Enriquecimiento de eventos

- **Qué eventos entran**: los que tienen al menos `enrichMinSources` medios y nunca se han extraído, o cuyo número de artículos se ha duplicado desde la última extracción. Se procesan como máximo `enrichMaxEventsPerRun` por ciclo.
- **Qué recibe el LLM**: los titulares y resúmenes de hasta 8 artículos por evento, más el vocabulario ya generado (tipos de evento y roles) para que lo reutilice.
- **Qué devuelve**: salida estructurada (JSON validado con zod) con título, resumen, tipo, actores con rol y lugares con rol (`occurred` o `involved`).
- **Si falla** (cuota, JSON roto, red) los eventos quedan sin procesar y se reintentan en el siguiente ciclo.

### Entidades

Una sola tabla `entities` con `kind` (`actor`, `location`) y `subtype` en texto libre, más `entity_aliases` y `event_entities` (con `role` y `weight`).

Para cada mención:

1. Se normaliza el nombre (minúsculas, sin acentos) y se busca en los alias.
2. Si no existe, se compara su embedding con las entidades del mismo tipo (`entityMergeSimilarity`). En lugares, además, el país no puede contradecirse (Georgia, país, no se fusiona con Georgia, estado).
3. Si tampoco hay parecido, se crea una entidad nueva.

El 0,90 de `entityMergeSimilarity` es un punto de partida, no un valor calibrado: si ves actores distintos fusionados, súbelo; si ves duplicados, bájalo.

### Coordenadas

El LLM aporta el **nombre** del lugar, no la coordenada. Cada lugar nuevo se geocodifica una sola vez:

1. **Open-Meteo** (sin clave): países, regiones y ciudades.
2. **Nominatim / OpenStreetMap** (máx. 1 petición por segundo): mares, estrechos e instalaciones.
3. Si ninguno lo conoce, se conservan las coordenadas aproximadas que dio el LLM (`geo_source = 'llm'`, marcadas con `≈` en el dashboard).

## Estructura

```
osint-radar/
├── dashboard.html        Panel de administración (HTML + JS; Mapbox GL JS se carga solo en la vista Mapa)
├── scripts/
│   └── dump.ts           Vuelca el código del proyecto en un solo .md
└── src/
    ├── index.ts          Servidor Hono: solo rutas y manejo de errores
    ├── config.ts         Entorno, constantes y ajustes por defecto
    ├── db.ts             bun:sqlite, esquema y migraciones ligeras
    ├── schemas.ts        Validación de entradas (zod)
    ├── types.ts          Tipos compartidos
    ├── utils.ts          Utilidades generales y normalización de nombres
    ├── vectors.ts        Álgebra de vectores y (de)serialización
    ├── gemini.ts         Cliente de embeddings, texto y JSON estructurado
    ├── geocode.ts        Open-Meteo y Nominatim
    ├── sources.ts        CRUD de fuentes
    ├── categories.ts     CRUD, prototipos y clasificación
    ├── events.ts         Agrupación de artículos en eventos y estado derivado
    ├── entities.ts       Resolución de entidades, enlaces con eventos y geocodificación
    ├── enrich.ts         Extracción con LLM de resumen, tipo, actores y lugares
    ├── ingest.ts         Descarga y parseo de RSS/GDELT
    ├── pipeline.ts       Ciclo: ingesta → embeddings → clasificación → eventos → enriquecimiento
    ├── queries.ts        Consultas de lectura (métricas, tendencias, eventos, entidades)
    ├── runs.ts           Registro de ejecuciones
    ├── settings.ts       Ajustes editables
    ├── digest.ts         Briefing con LLM
    ├── scheduler.ts      Planificador (tick cada minuto)
    └── seed.ts           Fuentes y categorías iniciales
```

## Dashboard

| Sección | Qué permite |
|---|---|
| **Resumen** | KPIs, volumen diario, actores y lugares más activos, tendencias con anomalías, últimos ciclos. Botones para ejecutar un ciclo, enriquecer, reclasificar y reindexar |
| **Eventos** | Filtros por periodo, estado y tipo. Muestra resumen, primera noticia, actores y lugares (clicables). Al desplegar: roles y artículos |
| **Mapa** | Eventos por lugar (filtrables por periodo y estado), con tamaño según el número de medios y color según actividad (`Activo` vs. `Enfriándose / caducado`) |
| **Entidades** | Actores y lugares con filtros y búsqueda por alias. Ficha con alias, coocurrencias y eventos |
| **Artículos** | Listado filtrable por texto, categoría y fuente, con la similitud de cada categoría |
| **Categorías** | Crear y editar categorías (descripción, ejemplos, umbral) |
| **Fuentes** | Añadir, editar en línea, filtrar (por texto, tipo o errores), activar, descargar al momento, añadir las fuentes recomendadas y ver el último error |
| **Briefing** | Genera y muestra el resumen de las últimas 24 h |
| **Ajustes** | Eventos, enriquecimiento, geocodificación, retención y planificador |

El mapa usa **Mapbox GL JS** (`v3.28.0`, estilo `dark-v11`), cargado desde `api.mapbox.com` únicamente al abrir esa vista (necesita conexión y `MAPBOX_TOKEN`). La instancia del mapa se reutiliza en memoria al cambiar filtros o navegar entre pestañas para no generar cargas facturables innecesarias. El resto del dashboard no tiene dependencias externas.

## API

Todas las rutas cuelgan de `/api` y requieren `Authorization: Bearer <ADMIN_TOKEN>` si hay token configurado. `/health` y `/dashboard` son públicos.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/config` | Configuración pública para el cliente (`mapboxToken`) |
| GET | `/overview` | KPIs y volumen diario |
| GET | `/trends` | Tendencia y anomalías por categoría |
| GET | `/runs` | Últimas ejecuciones |
| GET | `/events?hours=&limit=&status=&type=&entity=` | Eventos con estado, actores y lugares |
| GET | `/events/:id` | Evento con sus artículos |
| GET | `/event-types` | Tipos de evento surgidos hasta ahora |
| GET | `/entities?kind=&hours=&limit=&q=` | Entidades (`hours=0` = todo el histórico) |
| GET | `/entities/:id` | Entidad con alias y coocurrencias |
| GET | `/articles?limit=&offset=&category=&source=&q=` | Listado de artículos |
| GET/POST | `/sources` | Listar / crear fuentes |
| POST | `/sources/defaults` | Añadir las fuentes recomendadas que falten |
| PATCH/DELETE | `/sources/:id` | Editar / eliminar fuente |
| POST | `/sources/:id/fetch` | Descargar una fuente ahora |
| GET/POST | `/categories` | Listar / crear categorías |
| PATCH/DELETE | `/categories/:id` | Editar / eliminar categoría |
| GET/PUT | `/settings` | Leer / guardar ajustes |
| POST | `/pipeline/run` | Ejecutar un ciclo completo |
| POST | `/pipeline/enrich` | Enriquecer eventos y geocodificar lugares ahora |
| POST | `/pipeline/reclassify` | Reclasificar con los embeddings guardados |
| POST | `/pipeline/reembed` | Descartar embeddings, eventos y entidades y recalcular todo |
| GET/POST | `/digest` | Último briefing / generar uno nuevo |

## Afinar la clasificación

1. Mira el KPI **Sin categoría (24 h)** del Resumen.
2. Si es alto, baja los umbrales en **Categorías** o añade titulares de ejemplo (en cualquier idioma).
3. Pulsa **Reclasificar**: es instantáneo y no consume cuota de la API.
4. Repite hasta que el resultado cuadre. El 0,60 por defecto es un punto de partida, no un valor calibrado.

Si cambias `EMBEDDING_MODEL` o `EMBEDDING_DIMENSIONS`, usa **Reindexar todo**: los vectores de modelos distintos no son comparables. Esto también borra las entidades, que se regeneran en los ciclos siguientes.

## Solución de problemas

| Síntoma | Causa y solución |
|---|---|
| Errores 400 en todas las llamadas del dashboard | Cabecera `Authorization` vacía o `ADMIN_TOKEN` con caracteres no permitidos. Usa solo `A-Z a-z 0-9 . _ ~ + / -` |
| `ERR_EMPTY_RESPONSE` al ejecutar ciclo, reclasificar o generar briefing | Timeout de inactividad de Bun. `idleTimeout: 255` en el `export default` de `src/index.ts` |
| Artículos descargados pero sin categoría | Falta `GEMINI_API_KEY`, o los umbrales son demasiado altos |
| Eventos sin actores ni lugares | Falta `GEMINI_API_KEY`, `enrichEnabled` está desactivado o los eventos no llegan a `enrichMinSources` medios. Prueba a bajarlo a 1 |
| Lugares sin coordenadas | Open-Meteo y Nominatim no lo conocen o no hay red. Los lugares fallidos no se reintentan; los errores de red sí |
| Actores distintos fusionados o duplicados | Ajusta `entityMergeSimilarity` en Ajustes (más alto = fusiona menos) |
| Una fuente muestra error | La URL del feed cambió o el sitio bloquea peticiones automáticas. El error aparece en **Fuentes** y puedes editarla allí mismo |
| Errores de cuota de Gemini | El ciclo falla (o el enriquecimiento se salta) y se reintenta al minuto siguiente; nada se pierde |
| GDELT devuelve errores intermitentes | Limita a ~1 petición cada 5 s; el servidor ya serializa y espera entre consultas |
| El mapa no carga o muestra error de token | Falta `MAPBOX_TOKEN` (`pk.…`) en `.env`, el token está caducado o restringido por URL, o no hay conexión para descargar Mapbox GL JS y los estilos |

## Scripts

| Comando | Qué hace |
|---|---|
| `bun run dev` | Servidor con recarga automática |
| `bun run start` | Servidor en modo normal |
| `bun run dump` | Vuelca el código en `project-dump.md` (excluye `.env`, `data/` y `node_modules/`) |

## Seguridad

- Define siempre `ADMIN_TOKEN` si el puerto es accesible desde fuera de tu máquina. Sin él, cualquiera puede crear fuentes y hacer que el servidor descargue URLs arbitrarias.
- El HTML del dashboard se sirve sin token porque no contiene datos; todos los datos (incluido `MAPBOX_TOKEN`) pasan por la API autenticada.
- Usa en `MAPBOX_TOKEN` únicamente un token público (`pk.…`), nunca un token secreto (`sk.…`), y restringe sus URLs permitidas en tu cuenta de Mapbox si expones el servidor.
- Nunca subas `.env` ni `data/` al repositorio (ya están en `.gitignore`).