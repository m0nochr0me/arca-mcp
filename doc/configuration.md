# Configuration

All settings are configured via environment variables with the `ARCA_` prefix, or
through a `.env` file in the project root. Settings are loaded by Pydantic
`BaseSettings` in [`app/core/config.py`](../app/core/config.py).

## Environment variables

| Variable | Type | Default | Description |
| - | - | - | - |
| `ARCA_APP_HOST` | `str` | `0.0.0.0` | Server bind address |
| `ARCA_APP_PORT` | `int` | `4201` | Server port |
| `ARCA_APP_WORKERS` | `int` | `1` | Uvicorn worker count |
| `ARCA_APP_AUTH_KEY` | `str` | **required** | Bearer token for MCP and REST authentication |
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
| `ARCA_CACHE_TTL_LONG` | `int` | `604800` | Long cache TTL in seconds (7 days, used for stored-document embeddings) |

## Notes

- **Required secrets** — the server will not start without `ARCA_APP_AUTH_KEY` and
  `ARCA_GOOGLE_API_KEY`.
- **Embedding dimension** — must match what the configured `ARCA_EMBEDDING_MODEL`
  produces and must be fixed for the lifetime of a LanceDB table. Changing it after
  data has been written requires re-embedding existing rows.
- **Cache TTLs** — `ARCA_CACHE_TTL` applies to query embeddings; `ARCA_CACHE_TTL_LONG`
  applies to stored-document embeddings, which are reused across reads. See
  [`app/util/embeds.py`](../app/util/embeds.py).
- **Storage path** — `ARCA_VECTOR_STORE_PATH` is a local directory. When running in
  Docker, mount a volume there to persist data across container restarts.
