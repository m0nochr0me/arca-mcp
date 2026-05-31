# Arca MCP

A Model Context Protocol (MCP) server providing semantic memory storage and retrieval via vector embeddings. Built with FastAPI + FastMCP, using LanceDB for vector storage and Google Gemini for embedding generation.

## Features

- **Semantic Search** — Store and retrieve memories using natural language queries powered by vector similarity search
- **Dual Access** — MCP tools for AI agents + REST API for programmatic integrations
- **Knowledge Graph** — Connect memories with directed, labelled edges and traverse them
- **Multi-Tenant Isolation** — Namespace-scoped operations via `X-Namespace` HTTP header
- **Bucket Organization** — Group memories into logical buckets for structured storage
- **JSON Canvas Export** — Render a bucket's memories and connections as a [JSON Canvas](https://jsoncanvas.org/) document
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
git clone https://github.com/m0nochr0me/arca-mcp.git
cd arca-mcp

# Install dependencies
uv sync --locked

# Configure environment — create a .env with at least the required secrets
cat > .env <<'EOF'
ARCA_APP_AUTH_KEY=your-secret-bearer-token
ARCA_GOOGLE_API_KEY=your-google-api-key
EOF

# Run the server
python -m app
```

The server starts on `http://0.0.0.0:4201` by default, with the MCP interface at `/app/mcp` and the REST API at `/v1`. See [Configuration](doc/configuration.md) for all available settings.

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

The Docker image uses Python 3.14 slim with UV for dependency management. Mount a volume at `ARCA_VECTOR_STORE_PATH` (default `./lancedb`) to persist data across container restarts.

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

`<your-auth-key>` must match `ARCA_APP_AUTH_KEY`. The `X-namespace` header scopes all operations to a tenant (defaults to `"default"` if omitted).

## Documentation

In-depth reference material lives in [`doc/`](doc/):

- **[Configuration](doc/configuration.md)** — all `ARCA_` environment variables and their defaults
- **[MCP Tools](doc/mcp-tools.md)** — the `memory/*` tool reference (add, get, graph traversal, …)
- **[REST API](doc/rest-api.md)** — `/v1/*` endpoint reference with `curl` examples
- **[Architecture](doc/architecture.md)** — request flow, module layout, key patterns, tech stack

## License

See [LICENSE](LICENSE).
