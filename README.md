# Radar OSINT

Servidor que recopila noticias de fuentes abiertas (RSS y GDELT), las **clasifica por significado con embeddings** y las **agrupa en eventos**, con un dashboard de administración incluido.

Las categorías se definen en lenguaje natural desde el dashboard. Para pasar de inteligencia militar a ciencia o tecnología basta con crear categorías y fuentes nuevas, sin tocar código.

## Características

- **Ingesta** de feeds RSS/Atom y consultas GDELT, con intervalo configurable por fuente.
- **Clasificación semántica**: cada categoría es una descripción más titulares de ejemplo; los artículos se asignan por similitud coseno. Funciona entre idiomas.
- **Eventos**: los artículos que cuentan lo mismo se agrupan por similitud con el centroide del evento.
- **Tendencias y anomalías** por categoría (z-score frente a la media de los días previos).
- **Briefing diario** redactado por un LLM a partir de los eventos de las últimas 24 h.
- **Dashboard** para gestionar fuentes, categorías, ajustes y ver métricas.
- **Persistencia** en un único archivo SQLite (`bun:sqlite`), sin servicios externos salvo la API de Gemini.

## Requisitos

- [Bun](https://bun.sh) 1.1 o superior.
- Una clave gratuita de Google AI Studio: https://aistudio.google.com

## Puesta en marcha

```bash
bun install
cp .env.example .env     # rellena GEMINI_API_KEY y ADMIN_TOKEN
bun run dev
```

Abre http://localhost:3000/dashboard. La primera vez pedirá el `ADMIN_TOKEN`.

Al arrancar por primera vez se crean fuentes y categorías de ejemplo. En unos minutos el planificador descarga artículos; también puedes pulsar **Ejecutar ciclo ahora** en el Resumen.

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `DATABASE_PATH` | `data/radar.sqlite` | Ruta del archivo SQLite |
| `ADMIN_TOKEN` | *(vacío)* | Protege la API. Solo letras, números y `._~+/-`. Vacío = API abierta |
| `GEMINI_API_KEY` | *(vacío)* | Sin ella se descargan artículos pero no se clasifican |
| `EMBEDDING_MODEL` | `gemini-embedding-001` | Modelo de embeddings |
| `DIGEST_MODEL` | `gemini-2.5-flash` | Modelo del briefing |

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
 articles (status = processed) → tendencias, eventos, briefing
```

- **Prototipos**: cada categoría tiene un vector por su descripción y uno por cada titular de ejemplo. Un artículo puntúa en una categoría con su prototipo más parecido, y se conserva si supera el umbral de esa categoría (máximo 3 categorías por artículo).
- **Embeddings guardados**: se almacenan junto al artículo, así que cambiar umbrales o categorías y pulsar **Reclasificar** no vuelve a llamar a la API.
- **Retención**: los datos más antiguos que `retentionDays` se eliminan en cada ciclo.

## Estructura

```
osint-radar/
├── dashboard.html        Panel de administración (HTML + JS sin dependencias)
├── scripts/
│   └── dump.ts           Vuelca el código del proyecto en un solo .md
└── src/
    ├── index.ts          Servidor Hono: solo rutas y manejo de errores
    ├── config.ts         Entorno, constantes y ajustes por defecto
    ├── db.ts             bun:sqlite y esquema
    ├── schemas.ts        Validación de entradas (zod)
    ├── types.ts          Tipos compartidos
    ├── utils.ts          Utilidades generales
    ├── vectors.ts        Álgebra de vectores y (de)serialización
    ├── gemini.ts         Cliente de embeddings y generación de texto
    ├── sources.ts        CRUD de fuentes
    ├── categories.ts     CRUD, prototipos y clasificación
    ├── events.ts         Agrupación de artículos en eventos
    ├── ingest.ts         Descarga y parseo de RSS/GDELT
    ├── pipeline.ts       Ciclo: ingesta → embeddings → clasificación → eventos
    ├── queries.ts        Consultas de lectura (métricas, tendencias, listados)
    ├── runs.ts           Registro de ejecuciones
    ├── settings.ts       Ajustes editables
    ├── digest.ts         Briefing con LLM
    ├── scheduler.ts      Planificador (tick cada minuto)
    └── seed.ts           Fuentes y categorías iniciales
```

## Dashboard

| Sección | Qué permite |
|---|---|
| **Resumen** | KPIs, volumen diario, tendencias con anomalías, últimos ciclos. Botones para ejecutar un ciclo, reclasificar y reindexar |
| **Eventos** | Eventos agrupados por nº de medios; despliega los artículos de cada uno |
| **Artículos** | Listado filtrable por texto, categoría y fuente, con la similitud de cada categoría |
| **Categorías** | Crear y editar categorías (descripción, ejemplos, umbral) |
| **Fuentes** | Añadir, activar, descargar al momento y ver el último error de cada fuente |
| **Briefing** | Genera y muestra el resumen de las últimas 24 h |
| **Ajustes** | Similitud de eventos, ventanas de tiempo, retención y planificador |

## API

Todas las rutas cuelgan de `/api` y requieren `Authorization: Bearer <ADMIN_TOKEN>` si hay token configurado. `/health` es público.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/overview` | KPIs y volumen diario |
| GET | `/trends` | Tendencia y anomalías por categoría |
| GET | `/runs` | Últimas ejecuciones |
| GET | `/events?hours=&limit=` | Eventos principales |
| GET | `/events/:id` | Artículos de un evento |
| GET | `/articles?limit=&offset=&category=&source=&q=` | Listado de artículos |
| GET/POST | `/sources` | Listar / crear fuentes |
| PATCH/DELETE | `/sources/:id` | Editar / eliminar fuente |
| POST | `/sources/:id/fetch` | Descargar una fuente ahora |
| GET/POST | `/categories` | Listar / crear categorías |
| PATCH/DELETE | `/categories/:id` | Editar / eliminar categoría |
| GET/PUT | `/settings` | Leer / guardar ajustes |
| POST | `/pipeline/run` | Ejecutar un ciclo completo |
| POST | `/pipeline/reclassify` | Reclasificar con los embeddings guardados |
| POST | `/pipeline/reembed` | Descartar embeddings y recalcular todo |
| GET/POST | `/digest` | Último briefing / generar uno nuevo |

## Afinar la clasificación

1. Mira el KPI **Sin categoría (24 h)** del Resumen.
2. Si es alto, baja los umbrales en **Categorías** o añade titulares de ejemplo (en cualquier idioma).
3. Pulsa **Reclasificar**: es instantáneo y no consume cuota de la API.
4. Repite hasta que el resultado cuadre. El 0,60 por defecto es un punto de partida, no un valor calibrado.

Si cambias `EMBEDDING_MODEL` o `EMBEDDING_DIMENSIONS`, usa **Reindexar todo**: los vectores de modelos distintos no son comparables.

## Solución de problemas

| Síntoma | Causa y solución |
|---|---|
| Errores 400 en todas las llamadas del dashboard | Cabecera `Authorization` vacía o `ADMIN_TOKEN` con caracteres no permitidos. Usa solo `A-Z a-z 0-9 . _ ~ + / -` |
| `ERR_EMPTY_RESPONSE` al ejecutar ciclo, reclasificar o generar briefing | Timeout de inactividad de Bun. `idleTimeout: 255` en el `export default` de `src/index.ts` |
| Artículos descargados pero sin categoría | Falta `GEMINI_API_KEY`, o los umbrales son demasiado altos |
| Una fuente muestra error | La URL del feed cambió o el sitio bloquea peticiones automáticas. El error aparece en **Fuentes** |
| Errores de cuota de Gemini | El ciclo falla y se reintenta al minuto siguiente; los artículos quedan pendientes, no se pierden |
| GDELT devuelve errores intermitentes | Limita a ~1 petición cada 5 s; el servidor ya espera entre consultas |

## Scripts

| Comando | Qué hace |
|---|---|
| `bun run dev` | Servidor con recarga automática |
| `bun run start` | Servidor en modo normal |
| `bun run dump` | Vuelca el código en `project-dump.md` (excluye `.env`, `data/` y `node_modules/`) |

## Seguridad

- Define siempre `ADMIN_TOKEN` si el puerto es accesible desde fuera de tu máquina. Sin él, cualquiera puede crear fuentes y hacer que el servidor descargue URLs arbitrarias.
- El HTML del dashboard se sirve sin token porque no contiene datos; todos los datos pasan por la API autenticada.
- Nunca subas `.env` ni `data/` al repositorio (ya están en `.gitignore`).

## Hoja de ruta

- Peso de fiabilidad por fuente para ordenar eventos.
- Botón «mal clasificado» que añada el titular como ejemplo de la categoría correcta.
- Entidades y geolocalización (el GKG de GDELT las incluye).
- Ciclo en segundo plano con progreso consultable desde el dashboard.