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
| `ARCA_EMBED_MAX_RETRIES` | `int` | `3` | Max retries for an embedding call on a transient 429/5xx |
| `ARCA_EMBED_RETRY_BASE_DELAY` | `float` | `0.5` | Base seconds for embedding-retry exponential backoff (with jitter) |
| `ARCA_VECTOR_STORE_PATH` | `str` | `./lancedb` | LanceDB storage directory |
| `ARCA_INGEST_CHUNK_SIZE` | `int` | `512` | Target chunk size in token-counter units (kept well under the embedder's 2048-token limit) |
| `ARCA_INGEST_CHUNK_OVERLAP` | `float` | `0.1` | Chunk overlap: a ratio of chunk size when `< 1`, else an absolute token count |
| `ARCA_INGEST_MAX_CHUNKS` | `int` | `2000` | Maximum chunks accepted per document (cost / runaway guard) |
| `ARCA_INGEST_TOKENIZER_MODEL` | `str` | `gemini-2.5-flash` | Gemini model whose local tokenizer counts chunk tokens (proxy for the embedding model) |
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
- **Embedding retries** — embedding calls retry transient `429`/`5xx` responses with
  exponential backoff plus jitter (`ARCA_EMBED_MAX_RETRIES`,
  `ARCA_EMBED_RETRY_BASE_DELAY`); other errors propagate immediately. This matters most
  for large document ingests, which issue many embed calls.
- **Storage path** — `ARCA_VECTOR_STORE_PATH` is a local directory. When running in
  Docker, mount a volume there to persist data across container restarts.
- **Document ingestion** — the `ARCA_INGEST_*` settings apply only when the optional
  `arca-ingest` add-on is installed (`uv sync --extra ingest`). Chunk sizes are measured
  with google-genai's local Gemini tokenizer when `sentencepiece` + `protobuf` are
  available, falling back to a word count otherwise. See
  [`doc/ingestion-plan.md`](ingestion-plan.md).
