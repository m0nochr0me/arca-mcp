# REST API

All REST endpoints are under `/v1`, require an `Authorization: Bearer <token>` header
(validated against `ARCA_APP_AUTH_KEY`), and accept an optional `X-Namespace` header
(defaults to `"default"`). The router is defined in
[`app/api/memory.py`](../app/api/memory.py).

Interactive OpenAPI docs are available at `/docs` when the server is running.

## Endpoints

| Method | Path | Description |
| - | - | - |
| `POST` | `/v1/memories` | Add a memory |
| `POST` | `/v1/memories/batch` | Add multiple memories in one request (max 100) |
| `POST` | `/v1/memories/search` | Semantic similarity search |
| `POST` | `/v1/memories/last` | Page through the most recent memories |
| `PATCH` | `/v1/memories/{memory_id}` | Update a memory's content and/or bucket |
| `DELETE` | `/v1/memories/{memory_id}` | Delete a memory (cascade-disconnects incoming edges) |
| `DELETE` | `/v1/memories?bucket=...` | Clear memories in a bucket |
| `GET` | `/v1/buckets` | List all buckets in the namespace |
| `POST` | `/v1/buckets/rename` | Rename a bucket (moves all its memories) |
| `GET` | `/v1/namespaces` | List all namespaces in the store |
| `GET` | `/v1/canvas?bucket=...` | Render a bucket as a JSON Canvas document |
| `POST` | `/v1/memories/connect` | Create a directed edge between two nodes |
| `POST` | `/v1/memories/disconnect` | Remove edges between two nodes |
| `GET` | `/v1/memories/{memory_id}/connected` | Traverse the knowledge graph from a node |
| `POST` | `/v1/ingest` | Chunk an uploaded document and store the chunks (optional `ingest` add-on) |
| `POST` | `/v1/ingest/text` | Chunk raw text and store the chunks (optional `ingest` add-on) |
| `GET` | `/v1/ingest/formats` | List installed loaders' file extensions (drives the web UI file picker) |

Request and response models are defined in
[`app/schema/memory.py`](../app/schema/memory.py) and
[`app/schema/canvas.py`](../app/schema/canvas.py).

### Result shape

Search, pagination, and traversal results carry the following fields:

| Field | Type | Description |
| - | - | - |
| `memory_id` | `str` (UUID) | Unique identifier |
| `content` | `str` | Stored content |
| `bucket` | `str` | Owning bucket |
| `connected_nodes` | `list[str]` | UUIDs this node links to |
| `relationship_types` | `list[str]` | Parallel edge labels for `connected_nodes` |
| `created_at` | `datetime \| null` | Creation timestamp |
| `source` | `str \| null` | Originating document (ingested rows only) |
| `chunk_index` | `int \| null` | Position of a chunk within its source document |
| `kind` | `str \| null` | `"chunk"` / `"document"` for ingested rows; `null` for ordinary memories |
| `_depth` | `int` | (`/connected` only) hop distance from the starting node |

> **Search hygiene.** A search or `/memories/last` call **without** a `bucket` returns
> curated facts only — ingested document rows (`kind` of `"chunk"`/`"document"`) are
> excluded so they don't drown out hand-written memories. Scope the request to the
> document's `bucket` to search its chunks.

## Examples

All examples assume the server is running at `localhost:4201`. Replace `$TOKEN` with
your `ARCA_APP_AUTH_KEY`.

### Add a memory

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

### Add memories in batch

```bash
curl -X POST http://localhost:4201/v1/memories/batch \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {"content": "User timezone is US/Eastern", "bucket": "preferences"},
      {"content": "Project Alpha deadline is 2025-10-15", "bucket": "work"}
    ]
  }'
```

```json
{
  "status": "Memories added",
  "memory_ids": [
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "b2c3d4e5-f6a7-8901-bcde-f23456789012"
  ]
}
```

### Search memories

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
      "bucket": "preferences",
      "connected_nodes": [],
      "relationship_types": [],
      "created_at": "2026-06-01T12:00:00Z"
    }
  ]
}
```

### List recent memories (paginated)

`n` (1–100, default 5) sets the page size, `offset` skips the most recent memories, and
`all: true` returns everything (ignoring `n`/`offset` — use sparingly). The response
includes `total` so clients can paginate.

```bash
curl -X POST http://localhost:4201/v1/memories/last \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -H "Content-Type: application/json" \
  -d '{"n": 2, "offset": 0, "bucket": "work"}'
```

```json
{
  "status": "Memory retrieved",
  "results": [
    {
      "memory_id": "b2c3d4e5-f6a7-8901-bcde-f23456789012",
      "content": "Project Alpha deadline is 2025-10-15",
      "bucket": "work",
      "connected_nodes": [],
      "relationship_types": [],
      "created_at": "2026-06-01T12:01:00Z"
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 2
}
```

### Update a memory

Provide `content` (re-embedded if changed), `bucket`, or both.

```bash
curl -X PATCH http://localhost:4201/v1/memories/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -H "Content-Type: application/json" \
  -d '{"content": "User prefers high-contrast dark mode"}'
```

```json
{ "status": "Memory updated" }
```

### Delete a memory

```bash
curl -X DELETE http://localhost:4201/v1/memories/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project"
```

```json
{ "status": "Memory deleted" }
```

### Clear a bucket

```bash
curl -X DELETE "http://localhost:4201/v1/memories?bucket=preferences" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project"
```

```json
{ "status": "Memories cleared" }
```

### List buckets

```bash
curl http://localhost:4201/v1/buckets \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project"
```

```json
{ "buckets": ["default", "preferences", "work"] }
```

### Rename a bucket

```bash
curl -X POST http://localhost:4201/v1/buckets/rename \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -H "Content-Type: application/json" \
  -d '{"old_name": "work", "new_name": "projects"}'
```

```json
{ "status": "Bucket renamed", "count": 1 }
```

### List namespaces

Not namespace-scoped — lists every namespace present in the store.

```bash
curl http://localhost:4201/v1/namespaces \
  -H "Authorization: Bearer $TOKEN"
```

```json
{ "namespaces": ["default", "my_project"] }
```

## Knowledge-graph endpoints

### Connect nodes

```bash
curl -X POST http://localhost:4201/v1/memories/connect \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -H "Content-Type: application/json" \
  -d '{
    "source_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "target_id": "b2c3d4e5-f6a7-8901-bcde-f23456789012",
    "relationship_type": "related_to"
  }'
```

```json
{ "status": "Memories connected" }
```

### Disconnect nodes

Omit `relationship_type` to remove all edges between the two nodes.

```bash
curl -X POST http://localhost:4201/v1/memories/disconnect \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -H "Content-Type: application/json" \
  -d '{
    "source_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "target_id": "b2c3d4e5-f6a7-8901-bcde-f23456789012",
    "relationship_type": "related_to"
  }'
```

```json
{ "status": "Memories disconnected" }
```

### Traverse the graph

`depth` ranges 1–10 (default 1); `relationship_type` filters to a single edge label.

```bash
curl "http://localhost:4201/v1/memories/a1b2c3d4-e5f6-7890-abcd-ef1234567890/connected?depth=2" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project"
```

```json
{
  "status": "Graph traversed",
  "results": [
    {
      "memory_id": "b2c3d4e5-f6a7-8901-bcde-f23456789012",
      "content": "Project Alpha deadline is 2025-10-15",
      "bucket": "work",
      "connected_nodes": [],
      "relationship_types": [],
      "created_at": "2026-06-01T12:01:00Z",
      "_depth": 1
    }
  ]
}
```

## Document ingestion

Provided by the optional **`arca-ingest`** add-on (`uv sync --extra ingest`); defined in
[`app/api/ingest.py`](../app/api/ingest.py). When the add-on is not installed, both routes
return `501 Not Implemented`. A document is split into chunks; each chunk is embedded and
stored as a memory in a per-document bucket (derived from the source name unless `bucket`
is given).

**Formats.** `.txt` / `.md` work out of the box. Richer formats each need an optional
parser, installed into the server environment as an `arca-ingest` extra:

| Extension | Extra | Parser |
| - | - | - |
| `.pdf` | `arca-ingest[pdf]` | `pypdf` |
| `.docx` | `arca-ingest[docx]` | `python-docx` |
| `.html`, `.htm` | `arca-ingest[html]` | `beautifulsoup4` |
| `.epub` | `arca-ingest[epub]` | `ebooklib` + `beautifulsoup4` |
| `.fb2` | `arca-ingest[fb2]` | `defusedxml` (stdlib XML, hardened) |

A loader registers itself as soon as its parser is importable in the environment, so
`uv pip install pypdf` (or `arca-ingest[all]` for every format) is enough to light up that
extension — no server change or restart-time config. Posting a format whose parser isn't
installed returns `415` with a message naming the extra to install.

**Discovery.** `GET /v1/ingest/formats` returns `{ "available": bool, "extensions": [...] }`
listing exactly the extensions the running server can parse. The web-UI ingest dropzone
calls it to populate the file picker's `accept` filter and reject unsupported drops; when
`available` is `false` (add-on absent) the UI hides the ingest affordance.

**Provenance & graph.** Every chunk carries its `source` and `chunk_index` and a `next` →
following-chunk edge, so a document's structure is traversable via
`/v1/memories/{id}/connected` and renders in `/v1/canvas`. By default each document also
gets a `kind="document"` parent node (content = `source`) that the chunks link to via
`part_of`; the response returns its `parent_id`. Control the parent with these fields:

| Field | Type | Description |
| - | - | - |
| `parent` | `bool` | Create a parent node the chunks attach to (default `true`); set `false` to skip |
| `parent_content` | `str \| null` | Content for the created parent node (defaults to the `source`/file name) |
| `parent_id` | `str \| null` | Attach the chunks to this existing node instead of creating one |

To group several files under **one** parent, create it on the first upload (with
`parent_content`) and pass the returned `parent_id` on the rest — which is exactly what the
web UI's multi-file ingest does.

**Idempotent re-ingestion.** Re-posting byte-identical content for the same `source` is a
no-op: the response has `"skipped": true` and an empty `memory_ids`, and nothing is
re-embedded. Dedup is scoped to the `source`, so several documents can share one `bucket`
(post each file with the same `bucket`) and each one is skipped/updated independently. Set
`replace=true` to clear the **whole** bucket and rebuild it (e.g. after a source changed);
when loading several files into a shared bucket, send `replace=true` only on the first.

### Ingest an uploaded file

```bash
curl -X POST http://localhost:4201/v1/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -F "file=@notes.md" \
  -F "replace=true"
```

```json
{
  "status": "Document ingested",
  "bucket": "notes",
  "chunks": 12,
  "memory_ids": ["a1b2c3d4-e5f6-7890-abcd-ef1234567890", "b2c3d4e5-f6a7-8901-bcde-f23456789012"],
  "skipped": false,
  "parent_id": "c3d4e5f6-a7b8-9012-cdef-3456789012ab"
}
```

A no-op re-ingest instead returns `"status": "Document unchanged"`, `"skipped": true`, and
`"memory_ids": []`. Unsupported file types return `415`; documents exceeding
`ARCA_INGEST_MAX_CHUNKS` return `422`.

### Ingest raw text

```bash
curl -X POST http://localhost:4201/v1/ingest/text \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project" \
  -H "Content-Type: application/json" \
  -d '{"text": "# Report\n\nLong document text...", "source": "report.md", "replace": true}'
```

The response shape is identical to the file upload. Stored chunks are ordinary memories,
retrievable via `/v1/memories/search` **scoped to the document's `bucket`** (a global
search omits them — see Search hygiene above).

## JSON Canvas

`GET /v1/canvas?bucket=<name>` renders a bucket's memories and their connections as a
[JSON Canvas 1.0](https://jsoncanvas.org/spec/1.0/) document. Each node and edge carries
an extra `arca` object with domain metadata; this is ignored by spec-compliant renderers
(e.g. Obsidian) but consumed by the in-app canvas.

Edges crossing into other buckets are attached to compact "external" stub nodes that
carry the target bucket, so clients can navigate there. Node positions are a deterministic
grid seed; interactive clients may relax the layout on top.

```bash
curl "http://localhost:4201/v1/canvas?bucket=work" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Namespace: my_project"
```

```json
{
  "nodes": [
    {
      "id": "b2c3d4e5-f6a7-8901-bcde-f23456789012",
      "type": "text",
      "text": "Project Alpha deadline is 2025-10-15",
      "x": 0, "y": 0, "width": 260, "height": 120,
      "arca": { "kind": "memory", "bucket": "work" }
    }
  ],
  "edges": []
}
```

## Other endpoints

These are not part of the `/v1` API and are excluded from the OpenAPI schema unless noted.

| Method | Path | Description |
| - | - | - |
| `GET` | `/` | Index — returns `{ "message": "OK" }` |
| `GET` | `/health` | Health check — status, version, uptime, exec ID |
| `GET` | `/docs` | Interactive OpenAPI documentation |
| `GET` | `/memory` | Operator console (web UI) for browsing, editing, and ingesting documents |
| `GET` | `/canvas` | Interactive per-bucket knowledge-graph canvas (web UI) |
| `*` | `/app/mcp` | MCP streamable-http endpoint (see [MCP Tools](mcp-tools.md)) |
