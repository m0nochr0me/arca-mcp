# Arca MCP

A Model Context Protocol (MCP) server providing semantic memory storage and retrieval via vector embeddings. Built with FastAPI + FastMCP, using LanceDB for vector storage and Google Gemini for embedding generation.

## Features

- **Semantic Search** — Store and retrieve memories using natural language queries powered by vector similarity search
- **Dual Access** — MCP tools for AI agents + REST API for programmatic integrations
- **Multi-Tenant Isolation** — Namespace-scoped operations via `X-Namespace` HTTP header
- **Bucket Organization** — Group memories into logical buckets for structured storage
- **Embedding Caching** — Redis-backed cache for generated embeddings to minimize API calls
- **Bearer Token Auth** — Constant-time token verification for secure access

## Prerequisites

- Python 3.14+
- [UV](https://docs.astral.sh/uv/) package manager
- Redis
- Google API key (for Gemini embeddings)

## Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/arca-mcp.git
cd arca-mcp

# Install dependencies
uv sync --locked

# Configure environment
cp .env.example .env
# Edit .env with your ARCA_GOOGLE_API_KEY and ARCA_APP_AUTH_KEY

# Run the server
python -m app
```

The server starts on `http://0.0.0.0:4201` by default, with MCP available at `/app/mcp` and REST API at `/v1`.

## Configuration

All settings are configured via environment variables with the `ARCA_` prefix, or through a `.env` file.

| Variable | Type | Default | Description |
| - | - | - | - |
| `ARCA_APP_HOST` | `str` | `0.0.0.0` | Server bind address |
| `ARCA_APP_PORT` | `int` | `4201` | Server port |
| `ARCA_APP_WORKERS` | `int` | `1` | Uvicorn worker count |
| `ARCA_APP_AUTH_KEY` | `str` | **required** | Bearer token for MCP authentication |
| `ARCA_TRANSPORT` | `str` | `streamable-http` | MCP transport (`stdio`, `http`, `sse`, `streamable-http`) |
| `ARCA_DEBUG` | `bool` | `false` | Enable debug mode |
| `ARCA_LOG_MESSAGE_MAX_LEN` | `int` | `2000` | Maximum log message length |
| `ARCA_GOOGLE_API_KEY` | `str` | **required** | Google API key for Gemini embeddings |
| `ARCA_EMBEDDING_MODEL` | `str` | `gemini-embedding-001` | Gemini embedding model name |
| `ARCA_EMBEDDING_DIMENSION` | `int` | `3072` | Embedding vector dimensionality |
| `ARCA_VECTOR_STORE_PATH` | `str` | `./lancedb` | LanceDB storage directory |
| `ARCA_REDIS_HOST` | `str` | `localhost` | Redis host |
| `ARCA_REDIS_PORT` | `int` | `6379` | Redis port |
| `ARCA_REDIS_DB_CACHE` | `int` | `4` | Redis database number for cache |
| `ARCA_REDIS_PASSWORD` | `str` | `null` | Redis password (optional) |
| `ARCA_CACHE_TTL` | `int` | `3600` | Default cache TTL in seconds (1 hour) |
| `ARCA_CACHE_TTL_LONG` | `int` | `604800` | Long cache TTL in seconds (7 days, used for embeddings) |

## MCP Tools

All tools are mounted under the `memory` namespace. Operations are scoped to the namespace provided via the `X-namespace` HTTP header (defaults to `"default"`).

### `memory/add`

Store content in memory with a vector embedding.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `content` | `str` | yes | Content to store |
| `bucket` | `str \| null` | no | Bucket name (defaults to `"default"`) |
| `connected_nodes` | `list[str] \| null` | no | UUIDs of nodes to link at creation time |
| `relationship_types` | `list[str] \| null` | no | Parallel relationship labels for `connected_nodes` |

**Returns:** `{ "status": "Memory added", "memory_id": "<uuid>" }`

### `memory/get`

Retrieve memories via semantic similarity search.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `query` | `str` | yes | Natural language search query |
| `bucket` | `str \| null` | no | Filter by bucket |
| `top_k` | `int` | no | Number of results (default: `5`) |

**Returns:** `{ "status": "Memory retrieved", "results": [...] }`

### `memory/delete`

Delete a specific memory by its UUID.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `memory_id` | `str` | yes | UUID of the memory to delete |

**Returns:** `{ "status": "Memory deleted" }`

### `memory/clear`

Clear all memories in a bucket.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `bucket` | `str \| null` | no | Bucket to clear (defaults to `"default"`) |

**Returns:** `{ "status": "Memories cleared" }`

### `memory/list_buckets`

List all buckets in the current namespace.

**Parameters:** None

**Returns:** `{ "buckets": ["default", "work", ...] }`

### `memory/connect`

Create a directed edge between two memory nodes.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `source_id` | `str` | yes | UUID of the source node |
| `target_id` | `str` | yes | UUID of the target node |
| `relationship_type` | `str` | yes | Edge label (e.g. `"related_to"`, `"depends_on"`) |

**Returns:** `{ "status": "Memories connected" }`

### `memory/disconnect`

Remove one or all directed edges between two nodes.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `source_id` | `str` | yes | UUID of the source node |
| `target_id` | `str` | yes | UUID of the target node |
| `relationship_type` | `str \| null` | no | If provided, only remove this edge label; otherwise remove all edges |

**Returns:** `{ "status": "Memories disconnected" }`

### `memory/traverse`

Traverse the knowledge graph starting from a node.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `memory_id` | `str` | yes | UUID of the starting node |
| `relationship_type` | `str \| null` | no | Filter traversal to this edge label |
| `depth` | `int` | no | Number of hops (default: `1`) |

**Returns:** `{ "status": "Graph traversed", "results": [...] }` — each result includes a `_depth` field.

## REST API

All REST endpoints are under `/v1`, require a `Authorization: Bearer <token>` header, and accept an optional `X-Namespace` header (defaults to `"default"`).

Interactive API docs are available at `/docs` when the server is running.

| Method | Path | Description |
| - | - | - |
| `POST` | `/v1/memories` | Add a memory |
| `POST` | `/v1/memories/search` | Semantic similarity search |
| `DELETE` | `/v1/memories/{memory_id}` | Delete a specific memory |
| `DELETE` | `/v1/memories?bucket=...` | Clear memories in a bucket |
| `GET` | `/v1/buckets` | List all buckets |
| `POST` | `/v1/memories/connect` | Create a directed edge between two nodes |
| `POST` | `/v1/memories/disconnect` | Remove edges between two nodes |
| `GET` | `/v1/memories/{memory_id}/connected` | Traverse the knowledge graph from a node |

### Examples

All examples assume the server is running at `localhost:4201`. Replace `$TOKEN` with your `ARCA_APP_AUTH_KEY`.

#### Add a memory

```bash
curl -X POST http://localhost:4201/v1/memories \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers dark mode", "bucket": "preferences"}'
```

```json
{
  "status": "Memory added",
  "memory_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

#### Search memories

```bash
curl -X POST http://localhost:4201/v1/memories/search \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -H "Content-Type: application/json" \
  -d '{"query": "what theme does the user like?", "top_k": 3}'
```

```json
{
  "status": "Memory retrieved",
  "results": [
    {
      "memory_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "content": "User prefers dark mode",
      "bucket": "preferences"
    }
  ]
}
```

#### Delete a memory

```bash
curl -X DELETE http://localhost:4201/v1/memories/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project"
```

```json
{
  "status": "Memory deleted"
}
```

#### Clear a bucket

```bash
curl -X DELETE "http://localhost:4201/v1/memories?bucket=preferences" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project"
```

```json
{
  "status": "Memories cleared"
}
```

#### List buckets

```bash
curl http://localhost:4201/v1/buckets \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project"
```

```json
{
  "buckets": ["default", "preferences", "work"]
}
```

## Other Endpoints

| Method | Path | Description |
| - | - | - |
| `GET` | `/` | Index — returns `{ "message": "OK" }` |
| `GET` | `/health` | Health check — returns status, version, uptime, exec ID |
| `GET` | `/docs` | Interactive OpenAPI documentation |
| `*` | `/app/mcp` | MCP streamable-http endpoint |

## Docker

```bash
# Build
docker build -t arca-mcp .

# Run
docker run -p 4201:4201 \
  -e ARCA_APP_AUTH_KEY=your-secret-key \
  -e ARCA_GOOGLE_API_KEY=your-google-api-key \
  -e ARCA_REDIS_HOST=host.docker.internal \
  arca-mcp
```

The Docker image uses Python 3.14 slim with UV for dependency management.

## MCP Client Configuration

Example `.mcp.json` for connecting an MCP client (e.g., Claude Code):

```json
{
  "mcpServers": {
    "arca_memory": {
      "type": "http",
      "url": "http://localhost:4201/app/mcp",
      "headers": {
        "Authorization": "Bearer <your-auth-key>",
        "X-namespace": "my_namespace"
      }
    }
  }
}
```

## Architecture

```text
              ┌─ /app/mcp → FastMCP Auth → MCP Tool Handler  ─┐
Request → FastAPI                                             ├→ Gemini Embedding (Redis cache) → LanceDB
              └─ /v1/*    → Bearer Auth  → REST Router ───────┘
                                  ↑
                        X-Namespace header (multi-tenancy)
```

### Module Layout

```text
app/
├── __main__.py          # Uvicorn entry point
├── main.py              # FastAPI app, lifespan, MCP mount, REST router
├── api/
│   ├── deps.py          # Shared dependencies (auth, namespace extraction)
│   └── memory.py        # REST API router for memory operations
├── context/
│   └── memory.py        # MCP tool definitions (add, get, delete, clear, list_buckets)
├── core/
│   ├── config.py        # Pydantic BaseSettings with ARCA_ env prefix
│   ├── db.py            # LanceDB async connection management
│   ├── cache.py         # Redis cache wrapper
│   ├── ai.py            # Google Gemini AI client
│   └── log.py           # Loguru logging configuration
├── schema/
│   ├── memory.py        # REST API request/response models
│   └── status.py        # Response models (HealthCheckResponse, IndexResponse)
└── util/
    ├── embeds.py         # Embedding generation with Redis caching
    └── memory.py         # Core memory CRUD against LanceDB (PyArrow schema)
```

## Tech Stack

- **[FastAPI](https://fastapi.tiangolo.com/)** — ASGI web framework
- **[FastMCP](https://github.com/jlowin/fastmcp)** — Model Context Protocol server framework
- **[LanceDB](https://lancedb.com/)** — Serverless vector database
- **[Google Gemini](https://ai.google.dev/)** — Embedding generation (`gemini-embedding-001`)
- **[Redis](https://redis.io/)** — Embedding cache layer
- **[Pydantic](https://docs.pydantic.dev/)** — Settings and data validation
- **[UV](https://docs.astral.sh/uv/)** — Python package manager
- **[Loguru](https://github.com/Delgan/loguru)** — Logging
