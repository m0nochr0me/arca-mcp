# MCP Tools

The MCP interface is served at `/app/mcp` (streamable-http). All tools are mounted
under the `memory` namespace, so they're invoked as `memory/add`, `memory/get`, and so
on. Tool definitions live in [`app/context/memory.py`](../app/context/memory.py).

Operations are scoped to the namespace provided via the `X-Namespace` HTTP header
(defaults to `"default"`). Authentication uses a Bearer token validated against
`ARCA_APP_AUTH_KEY`.

See [MCP Client Configuration](../README.md#mcp-client-configuration) in the README for
a sample `.mcp.json`.

## `memory/add`

Store content in memory with a vector embedding, optionally with initial graph edges.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `content` | `str` | yes | Content to store |
| `bucket` | `str \| null` | no | Bucket name (defaults to `"default"`) |
| `connected_nodes` | `list[str] \| null` | no | UUIDs of nodes to link at creation time |
| `relationship_types` | `list[str] \| null` | no | Parallel relationship labels for `connected_nodes` |

**Returns:** `{ "status": "Memory added", "memory_id": "<uuid>" }`

## `memory/get`

Retrieve memories via semantic similarity search.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `query` | `str` | yes | Natural language search query |
| `bucket` | `str \| null` | no | Filter by bucket |
| `top_k` | `int` | no | Number of results (default: `5`) |

**Returns:** `{ "status": "Memory retrieved", "results": [...] }` (status is
`"No memory found"` when empty).

## `memory/get_last`

Retrieve the most recent memories, ordered by creation time (newest first).

| Parameter | Type | Required | Description |
| - | - | - | - |
| `n` | `int` | no | Number of recent memories to return (default: `5`) |
| `bucket` | `str \| null` | no | Filter by bucket |

**Returns:** `{ "status": "Memory retrieved", "results": [...] }`

## `memory/delete`

Delete a specific memory by its UUID.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `memory_id` | `str` | yes | UUID of the memory to delete |

**Returns:** `{ "status": "Memory deleted" }`

## `memory/clear`

Clear all memories in a bucket.

| Parameter | Type | Required | Description |
| - | - | - | - |
| `bucket` | `str \| null` | no | Bucket to clear (defaults to `"default"`) |

**Returns:** `{ "status": "Memories cleared" }`

## `memory/list_buckets`

List all buckets in the current namespace.

**Parameters:** None

**Returns:** `{ "buckets": ["default", "work", ...] }`

## `memory/ingest`

Chunk a document and store the chunks as memories. Available only when the optional
`arca-ingest` add-on is installed (`uv sync --extra ingest`).

| Parameter | Type | Required | Description |
| - | - | - | - |
| `text` | `str` | yes | Document text to chunk and store |
| `source` | `str` | yes | Source name; seeds the per-document bucket |
| `bucket` | `str \| null` | no | Override bucket (defaults to a name derived from `source`) |
| `replace` | `bool` | no | Clear the target bucket before ingesting (default: `false`) |

**Returns:** `{ "status": "Document ingested", "bucket": "<name>", "chunks": <int>, "memory_ids": ["<uuid>", ...] }`

The stored chunks are ordinary memories, retrievable with `memory/get`.

## Knowledge-graph tools

Edges are directed and labelled. They are stored as parallel lists
(`connected_nodes`, `relationship_types`) directly on the source memory row.

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
| `relationship_type` | `str \| null` | no | If provided, only remove this edge label; otherwise remove all edges between the two nodes |

**Returns:** `{ "status": "Memories disconnected" }`

### `memory/traverse`

Traverse the knowledge graph starting from a node, returning connected memories up to
`depth` hops away (BFS).

| Parameter | Type | Required | Description |
| - | - | - | - |
| `memory_id` | `str` | yes | UUID of the starting node |
| `relationship_type` | `str \| null` | no | Filter traversal to this edge label |
| `depth` | `int` | no | Number of hops (default: `1`; `1` = direct neighbours only) |

**Returns:** `{ "status": "Graph traversed", "results": [...] }` — each result includes
a `_depth` field indicating its distance from the starting node.

## Result shape

Search and traversal results carry the following fields:

| Field | Type | Description |
| - | - | - |
| `memory_id` | `str` (UUID) | Unique identifier |
| `content` | `str` | Stored content |
| `bucket` | `str` | Owning bucket |
| `connected_nodes` | `list[str]` | UUIDs this node links to |
| `relationship_types` | `list[str]` | Parallel edge labels for `connected_nodes` |
| `created_at` | `datetime \| null` | Creation timestamp |
| `_depth` | `int` | (traverse only) hop distance from the starting node |
