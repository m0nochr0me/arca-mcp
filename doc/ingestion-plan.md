# Document Ingestion Add-on — Implementation Plan

> **Status:** Phases 0–2 implemented (2026-06-01). The `arca-ingest` package, the
> `POST /v1/ingest` + `/v1/ingest/text` endpoints, and the `memory/ingest` MCP tool are
> live; reference docs are in `configuration.md`, `rest-api.md`, and `mcp-tools.md`.
> Phases 3–4 (a web UI ingestion affordance; then additional format loaders) remain the
> design reference below. Deviations from the original plan:
> - `ARCA_INGEST_ENABLED` was dropped — install-gating via the `ingest` extra already
>   provides the on/off switch.
> - **Phase 2 dedup** uses no `content_hash` column: the `source`/`chunk_index` columns
>   already let re-ingestion compare existing chunk contents (sha256 of the ordered
>   chunk list), so an identical re-ingest is a no-op (`skipped`) without a schema add.
> - **Search hygiene** excludes *both* ingestion kinds (`chunk` **and** the `document`
>   anchor) from global `get`/`get_last`, not just `chunk` — a bucket-scoped query still
>   returns them. The anchor's content is only a filename, so it is navigational, not a
>   curated fact.

## Goal

Let Arca ingest whole documents (starting with `.txt` / `.md`) by splitting them into
semantically coherent chunks, embedding each chunk, and storing the chunks as ordinary
memories — without bloating the core server's dependency footprint. Chunking and parsing
live in a **separate, optional package** so a minimal install never pulls them in.

Success criteria:

1. `uv sync` (core) installs **no** chunking/parsing dependencies.
2. `uv sync --extra ingest` lights up a `POST /v1/ingest` endpoint and a `memory/ingest`
   MCP tool.
3. Posting a `.md` file produces N chunk-memories in a per-document bucket, retrievable
   via the existing `memory/get` semantic search.
4. The chunker is a pure function with unit tests (the repo's first tests).

## Design decisions

These resolve the choices made during exploration and one tension between them.

- **A1 packaging, in-process consumption.** The heavy deps live in a standalone
  workspace package (`packages/arca-ingest`) — that is the decoupling virtue of "A1".
  But because we also want **server endpoints + MCP tools** (choice 4), ingestion runs
  *inside the server process* and writes through the existing `add_memories` core,
  **not** over a self-directed HTTP call. The package is therefore a **transport-agnostic
  library** (no FastAPI / server / HTTP imports); it could later be wrapped in a
  standalone CLI client, but the server is the first and primary consumer.
- **`semchunk` for chunking.** v4.0.0; hard deps are only `mpire[dill]` + `tqdm`
  (tiktoken / transformers are optional). We pass a **dependency-free token-counter
  callable** to `chunkerify` so no tokenizer wheel is pulled. The counter is pluggable —
  a real tokenizer can be swapped in later for accuracy.
- **Bucket-per-document for storage (first cut).** Each document maps to one bucket
  (derived from the source name, sanitized to `[\w\-. ]+`). This needs **zero schema
  change**, groups chunks for `/canvas`, and gives cheap idempotency via
  `clear_memories(bucket)`. True provenance columns (`source`, `chunk_index`, `kind`)
  are deferred to Phase 2 (see below).
- **Formats start at `txt` / `md`; others are extras.** Loaders are a registry keyed by
  extension. PDF / DOCX / HTML drop in later as `arca-ingest[pdf]` etc., keeping their
  parsers optional even within the add-on.
- **Conditional enablement.** The ingest REST router and MCP tool are registered only
  when `arca_ingest` is importable, so the core build is unaffected when the extra is
  absent.

## Architecture

```text
                       packages/arca-ingest  (optional, leaf library)
                       ┌───────────────────────────────────────────┐
                       │ loaders (txt/md→text)  →  chunker (semchunk)│
                       └───────────────────────────────────────────┘
                                        ▲ in-process import (when installed)
                                        │
  POST /v1/ingest ─┐                    │
                   ├─ app/api/ingest.py ─┤
  memory/ingest  ──┤  app/context/…   ───┘──→ add_memories()  →  embeds  →  LanceDB
  (MCP tool)       └──────────────────────────  (existing core, unchanged)
```

The add-on contributes **only** the dashed library box plus thin glue. The storage path
(`add_memories` → `get_embedding` batched → LanceDB) is reused as-is.

## The `arca-ingest` package

Pure-Python leaf library. **Does not import `arca-mcp`.**

```text
packages/arca-ingest/
├── pyproject.toml
└── src/arca_ingest/
    ├── __init__.py        # public API: ingest(), Chunk
    ├── loaders.py         # bytes/text + name → plain text; registry by extension
    ├── chunker.py         # semchunk wrapper; token-counter, chunk_size, overlap
    └── types.py           # Chunk dataclass (content, index, start/end offset)
```

### Public API (transport-agnostic, no embedding, no DB)

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class Chunk:
    content: str
    index: int
    start: int | None = None   # char offset in source (semchunk offsets=True)
    end: int | None = None

def load(data: bytes | str, *, name: str) -> str:
    """Decode/parse a supported source into plain text. Raises UnsupportedFormat."""

def chunk_text(
    text: str,
    *,
    chunk_size: int = 512,
    overlap: float | int = 0.1,
    token_counter=None,        # default: dependency-free heuristic
) -> list[Chunk]:
    """Split text into chunks via semchunk, returning ordered Chunk objects."""

def ingest(data: bytes | str, *, name: str, **chunk_kwargs) -> list[Chunk]:
    """load() then chunk_text(). The one call the server uses."""
```

- **Token counter default:** a heuristic such as `lambda t: max(1, len(t) // 4)`
  (≈4 chars/token) or a word-split counter. `chunk_size` is expressed in those units.
  Because the heuristic can under-count, the default `chunk_size` (512) sits well under
  Gemini's hard **2048-token** input ceiling, leaving margin.
- **`chunkerify` usage:** build the chunker once per call with
  `semchunk.chunkerify(token_counter, chunk_size, overlap=overlap)`, then call it with
  `offsets=True` to capture character spans for future provenance.

### Package `pyproject.toml` (sketch)

```toml
[project]
name = "arca-ingest"
version = "0.1.0"
requires-python = ">=3.14"
dependencies = ["semchunk>=4.0.0"]

[project.optional-dependencies]
pdf  = ["pypdf>=..."]
docx = ["python-docx>=..."]
html = ["beautifulsoup4>=..."]
```

### Workspace wiring (root `pyproject.toml`)

The `[tool.uv.workspace] members = ["packages/*"]` glob already includes it. Add the
add-on as an **optional dependency of the core** plus a workspace source:

```toml
[project.optional-dependencies]
ingest = ["arca-ingest"]

[tool.uv.sources]
arca-ingest = { workspace = true }
```

Core install: `uv sync`. With ingestion: `uv sync --extra ingest`.

## Server integration

### Glue module — `app/util/ingest.py`

Detects availability and provides one async helper the two front doors share:

```python
try:
    import arca_ingest
    INGEST_AVAILABLE = True
except ImportError:
    INGEST_AVAILABLE = False

async def ingest_document(
    data: bytes | str, *, name: str, bucket: str | None,
    namespace: str, replace: bool, chunk_size: int, overlap: float,
) -> dict:
    # 1. chunks = arca_ingest.ingest(data, name=name, chunk_size=..., overlap=...)
    # 2. enforce INGEST_MAX_CHUNKS cap
    # 3. bucket = sanitize(bucket or derive_from(name))
    # 4. if replace: await clear_memories(bucket, namespace)
    # 5. page chunks into groups of <=100 -> add_memories(items, namespace)
    # 6. return {"bucket", "chunks": N, "memory_ids": [...]}
```

Item shape passed to `add_memories`: `{"content": chunk.content, "bucket": bucket}`.
(Graph linking is Phase 2.)

### REST — `app/api/ingest.py`

A separate `ingest_router` (prefix `/v1`, `Depends(verify_token)`), included in
`app/main.py` **only if** `INGEST_AVAILABLE`:

- `POST /v1/ingest` — accepts either multipart `UploadFile` **or** JSON
  `{ text, source, bucket?, replace?, chunk_size?, overlap? }`.
- Response: `{ status, bucket, chunks, memory_ids }`.
- When the extra is not installed the route simply isn't mounted (or, if we prefer a
  discoverable stub, returns `501 Not Implemented`).

### MCP — tool in `app/context/memory.py`

Register under the existing `memory` namespace so it sits beside the other tools,
guarded by `INGEST_AVAILABLE`:

```python
@server.tool(tags={"memory", "ingest"})
async def ingest(
    text: Annotated[str, "Document text to chunk and store"],
    source: Annotated[str, "Source name; becomes the bucket"],
    bucket: Annotated[str | None, "Override bucket (defaults to source)"] = None,
    replace: Annotated[bool, "Clear the target bucket first"] = False,
) -> dict: ...
```

- MCP transports don't carry file uploads cleanly, so the tool takes **text**, not a
  file. A separate path-based tool is intentionally **omitted** (a server reading
  arbitrary local paths is a security footgun — see Constraints).

## Data model & storage

| Concern | First cut | Phase 2 |
| - | - | - |
| Chunk row | normal memory (`content`, `bucket`) | + `source`, `chunk_index`, `kind` columns (additive migration, like `created_at`) |
| Document grouping | bucket = sanitized source name | unchanged, but filterable by `source` |
| Provenance | bucket + insertion order (`created_at`) | explicit `chunk_index`, char offsets |
| Search hygiene | chunks share search space with curated facts | `kind != 'chunk'` predicate keeps `get` clean |
| Re-ingestion | `replace=true` → `clear_memories(bucket)` then re-add | content-hash dedup |
| Chunk navigation | ordering only | graph edges: a `document` anchor node + `part_of` (chunk→doc) and `next` (chunkₙ→chunkₙ₊₁) |

The Phase 2 additive-column migration follows the existing precedent in
`_get_memory_table()` (the `created_at` back-fill).

## Configuration additions

New `ARCA_`-prefixed settings in `app/core/config.py`:

| Variable | Type | Default | Description |
| - | - | - | - |
| `ARCA_INGEST_ENABLED` | `bool` | `true` | Master toggle (independent of import availability) |
| `ARCA_INGEST_CHUNK_SIZE` | `int` | `512` | Target chunk size in token-counter units (margin under Gemini's 2048 limit) |
| `ARCA_INGEST_CHUNK_OVERLAP` | `float` | `0.1` | Overlap ratio (`<1`) or absolute token count (`>=1`) |
| `ARCA_INGEST_MAX_CHUNKS` | `int` | `2000` | Safety cap on chunks per document (cost / runaway guard) |

## Constraints & edge cases

- **Gemini input ceiling (2048 tokens/text).** Each chunk must stay under it. The
  conservative default `chunk_size` plus the under-counting heuristic provide margin; if
  a chunk still over-runs, the embed call errors — the handler should surface a clear
  message rather than 500.
- **Batch cap (100).** `add_memories` / `get_embedding` cap at 100 per call. The handler
  pages chunks into ≤100 groups; each group is one batched (and Redis-cached) embed call.
- **Embed retry/backoff (Phase 2, done).** `embeds.py` retries transient 429/5xx embed
  responses with exponential backoff plus jitter (`ARCA_EMBED_MAX_RETRIES`,
  `ARCA_EMBED_RETRY_BASE_DELAY`); other errors propagate. This hardens large ingests,
  which issue many embed calls.
- **Bucket-name sanitization.** Source names become buckets and must pass
  `_sanitize` (`[\w\-. ]+`). The loader/handler normalizes filenames (drop extension,
  replace illegal chars) before use.
- **File-path ingestion is excluded.** Neither front door accepts a server-local path;
  ingestion is always by uploaded bytes or supplied text, to avoid arbitrary file reads.
- **Multi-tenancy preserved.** Ingestion is namespace-scoped via the existing
  `X-Namespace` header / dependency — no new auth surface.

## Phasing

**Phase 0 — package scaffold** ✅ DONE → verified: `uv sync --extra ingest` resolves;
11 unit tests pass; core `uv sync` prunes the add-on (no new deps).

1. Create `packages/arca-ingest` (pyproject, `loaders.py` for txt/md, `chunker.py`
   semchunk wrapper, `types.py`).
2. Wire workspace optional-dep + `[tool.uv.sources]` in root `pyproject.toml`.
3. Unit tests: known text → expected chunk count / boundaries / overlap.

**Phase 1 — server surface** ✅ DONE → verified end-to-end: posting `.md` text and a file
returns N chunks; chunks are retrievable via `/v1/memories/search`; unsupported types
return `415`. With the extra absent the routes return `501` (chosen over hiding them).
The accurate token counter uses google-genai's `LocalTokenizer` (`sentencepiece` +
`protobuf`, added to the extra), with a graceful word-count fallback.

4. `app/util/ingest.py` glue (availability flag + `ingest_document`).
5. `app/api/ingest.py` (`POST /v1/ingest`, multipart + JSON), conditionally included in
   `main.py`.
6. `memory/ingest` MCP tool in `app/context/memory.py`, conditionally registered.
7. Config vars; `replace` idempotency.
8. Docs: fold the relevant rows into `configuration.md`, `rest-api.md`, `mcp-tools.md`;
   README "optional add-on" note.

**Phase 2 — depth** ✅ DONE → verified end-to-end (TestClient on a temp store): ingest →
chunks carry `source`/`chunk_index`; global search/recent return curated facts only while
a bucket-scoped query returns the chunks; traversing a chunk reaches its `part_of` anchor
and `next` chunk; a byte-identical re-ingest is a `skipped` no-op; `replace=true` rebuilds.

9. Provenance columns (`source`, `chunk_index`, `kind`) + additive migration + the
   search-hygiene filter (excludes `chunk` **and** `document` anchors from global recall).
10. Graph linking (document anchor + `part_of` / `next` edges).
11. Content-comparison dedup (no new column; see deviations above); embed retry/backoff
    in `embeds.py` (exponential backoff + jitter on 429/5xx).

**Phase 3 — Web UI ingestion support**

12. Add an upload/ingest affordance to the operator console (`/memory`, with a hook from
    `/canvas`): a file picker / drag-and-drop that POSTs to `/v1/ingest`, reports the
    resulting bucket and chunk count, surfaces `415`/`422` errors, and links straight to
    the per-document bucket. Vue templates in `app/templates/` + assets in `app/static/`;
    no engine changes.

**Phase 4 — Formats support (separate later phase)**

13. Additional loaders, each an optional extra registered in `arca_ingest.loaders` with
    no server change: `pypdf` (PDF), `python-docx` (DOCX), `beautifulsoup4` (HTML),
    installed as `arca-ingest[pdf]` / `[docx]` / `[html]`.

## Open questions

- **Chunk size unit.** Ship with the char/word heuristic, or accept the small tiktoken
  dependency for token-accurate sizing from day one?
- **MCP namespace.** Keep `ingest` under the `memory` namespace, or mount a dedicated
  `ingest` FastMCP sub-server (tools become `ingest/document`)?
- **Absent-extra behavior.** Hide the route entirely, or expose a `501` stub so clients
  get a discoverable "add-on not installed" message?
