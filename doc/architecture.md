# Architecture

Arca MCP exposes the same memory engine through two front doors — an MCP interface for
AI agents and a REST API for programmatic clients — both backed by LanceDB vector
storage and Google Gemini embeddings.

```text
              ┌─ /app/mcp → FastMCP Auth → MCP Tool Handler  ─┐
Request → FastAPI                                             ├→ Gemini Embedding (Redis cache) → LanceDB
              └─ /v1/*    → Bearer Auth  → REST Router ───────┘
                                  ↑
                        X-Namespace header (multi-tenancy)
```

## Request flow

`app/__main__.py` → starts uvicorn → `app/main.py` creates the FastAPI app with a
lifespan context → mounts the FastMCP app at `/app/mcp` and includes the REST router at
`/v1`. The MCP tool layer ([`app/context/memory.py`](../app/context/memory.py)) and the
REST layer ([`app/api/memory.py`](../app/api/memory.py)) both call into the same core
CRUD in [`app/util/memory.py`](../app/util/memory.py).

## Module layout

```text
app/
├── __main__.py          # Uvicorn entry point
├── main.py              # FastAPI app, lifespan, MCP mount, REST router, web dashboards
├── api/
│   ├── deps.py          # Shared dependencies (Bearer auth, namespace extraction)
│   └── memory.py        # REST API router for memory operations
├── context/
│   └── memory.py        # MCP tool definitions (memory/* namespace)
├── core/
│   ├── config.py        # Pydantic BaseSettings with ARCA_ env prefix
│   ├── db.py            # LanceDB async connection management
│   ├── cache.py         # Redis cache wrapper
│   ├── ai.py            # Google Gemini AI client
│   └── log.py           # Loguru logging configuration
├── schema/
│   ├── memory.py        # REST request/response models
│   ├── canvas.py        # JSON Canvas response models
│   ├── status.py        # HealthCheckResponse, IndexResponse
│   └── log_entry.py     # Structured log entry model
├── util/
│   ├── embeds.py        # Embedding generation with Redis caching
│   ├── memory.py        # Core memory CRUD against LanceDB (PyArrow schema)
│   ├── canvas.py        # Map memory rows → JSON Canvas document
│   └── base_dir.py      # Module-root resolution for static/template paths
├── skills/              # Bundled MCP skill (arca-memory) served to clients
├── templates/           # Jinja2 templates for the web dashboards
└── static/              # CSS / JS / fonts for the web dashboards
```

`app/scratch/` holds exploratory dev scripts and is not part of the production app.

## Key patterns

- **Async-first** — all I/O is async (LanceDB, Redis, Gemini API). A global `_STATE`
  dataclass in `db.py` manages the connection lifecycle with event-loop-aware
  reconnection.
- **Namespace isolation** — every operation is scoped to a namespace taken from the
  `X-Namespace` header (defaults to `"default"`), providing multi-tenant separation.
- **Embedding caching** — generated embeddings are cached in Redis to avoid redundant
  Gemini calls. Query embeddings use `ARCA_CACHE_TTL` (1 hour); stored-document
  embeddings use `ARCA_CACHE_TTL_LONG` (7 days). Storage uses task type
  `RETRIEVAL_DOCUMENT`, search uses `RETRIEVAL_QUERY`.
- **Knowledge graph** — edges are stored as parallel lists (`connected_nodes`,
  `relationship_types`) directly on the source memory row in LanceDB. `get_connected`
  performs BFS up to `depth` hops. Deleting a node cascade-disconnects incoming edges.
- **Injection safety** — SQL filter inputs are sanitized via `_sanitize()` /
  `_sanitize_uuid()` in `app/util/memory.py` before being used in LanceDB predicates.
- **Auth** — `DebugTokenVerifier` validates Bearer tokens against `ARCA_APP_AUTH_KEY`
  using constant-time comparison (`secrets.compare_digest`).
- **Table maintenance** — a lifespan background task compacts the LanceDB table
  (`optimize_table` in `app/util/memory.py`) at startup and every
  `ARCA_DB_OPTIMIZE_INTERVAL` seconds. Each append/update commits a new fragment, and
  scans open all fragments of the current version at once, so an uncompacted table
  eventually fails with "Too many open files". The entry point also raises the soft
  `RLIMIT_NOFILE` to the hard limit as a second guard.

## Web dashboards

The server also serves two operator web consoles (Jinja2 + Vue, excluded from the
OpenAPI schema):

- `GET /memory` — browse, search, and edit memories.
- `GET /canvas` — interactive per-bucket knowledge-graph canvas, backed by the
  `/v1/canvas` endpoint.

## Tech stack

- **[FastAPI](https://fastapi.tiangolo.com/)** — ASGI web framework
- **[FastMCP](https://github.com/jlowin/fastmcp)** — Model Context Protocol server framework
- **[LanceDB](https://lancedb.com/)** — Serverless vector database
- **[Google Gemini](https://ai.google.dev/)** — Embedding generation (`gemini-embedding-001`)
- **[Redis](https://redis.io/)** — Embedding cache layer
- **[Pydantic](https://docs.pydantic.dev/)** — Settings and data validation
- **[UV](https://docs.astral.sh/uv/)** — Python package manager
- **[Loguru](https://github.com/Delgan/loguru)** — Logging
