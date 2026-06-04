"""
Utility functions for memory storage and retrieval using LanceDB.
"""

import re
from datetime import UTC, datetime
from uuid import UUID, uuid4

import pyarrow as pa
from lancedb import AsyncTable

from app.core.config import settings
from app.core.db import get_db
from app.util.embeds import get_embedding

_SAFE_IDENTIFIER = re.compile(r"^[\w\-. ]+$")
_SAFE_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def _sanitize(value: str, name: str) -> str:
    """Validate that a value is safe to interpolate into a SQL filter."""
    if not _SAFE_IDENTIFIER.match(value):
        raise ValueError(f"Invalid {name}: {value!r}")
    return value


def _sanitize_uuid(value: str) -> str:
    """Validate that a value is a well-formed UUID hex string."""
    if not _SAFE_UUID.match(value):
        raise ValueError(f"Invalid UUID: {value!r}")
    return value


def _sql_literal(value: str) -> str:
    """Quote *value* as a SQL string literal, escaping embedded single quotes.

    Used for free-form values like a document source/filename that can't go through
    :func:`_sanitize`'s identifier whitelist (they legitimately contain quotes, parens,
    spaces, non-Latin characters, ...). DataFusion (LanceDB) escapes a quote by doubling it.
    """
    return "'" + value.replace("'", "''") + "'"


__all__ = (
    "add_memories",
    "add_memory",
    "buckets_list",
    "clear_memories",
    "connect_memories",
    "delete_memory",
    "disconnect_memories",
    "get_chunk_contents",
    "get_connected",
    "get_id_bucket_map",
    "get_last_memories",
    "get_memory",
    "list_namespaces",
    "rename_bucket",
    "update_memory",
)

_MEMORY_SCHEMA = pa.schema(
    [
        ("memory_id", pa.uuid()),
        ("content", pa.large_string()),
        ("bucket", pa.string()),
        ("namespace", pa.string()),
        ("connected_nodes", pa.list_(pa.string())),
        ("relationship_types", pa.list_(pa.string())),
        ("vector", pa.list_(pa.float32(), list_size=settings.EMBEDDING_DIMENSION)),
        ("created_at", pa.timestamp("us", tz="UTC")),
        # Document-ingestion provenance (NULL for ordinary memories):
        ("source", pa.string()),  # originating document name
        ("chunk_index", pa.int32()),  # 0-based position within the source
        ("kind", pa.string()),  # "chunk" / "document" anchor; NULL = ordinary memory
    ]
)

# Predicate that drops ingested document rows (chunks + their anchor) from a result set,
# keeping global recall to curated facts. NULL-safe: ordinary memories and pre-migration
# rows have a NULL ``kind`` and must be kept.
_EXCLUDE_INGESTED = "(kind IS NULL OR kind NOT IN ('chunk', 'document'))"

# Columns returned to callers (everything bar the heavy vector).
_RESULT_COLUMNS = [
    "memory_id",
    "content",
    "bucket",
    "connected_nodes",
    "relationship_types",
    "created_at",
    "source",
    "chunk_index",
    "kind",
]


async def _get_memory_table() -> AsyncTable:
    """Get the LanceDB table for memory storage."""
    db = await get_db()

    table_names = await db.table_names()
    if "memory" in table_names:
        memory_table = await db.open_table("memory")

        # Migrate: add created_at column if missing (existing rows get NULL)
        schema = await memory_table.schema()
        if "created_at" not in schema.names:
            await memory_table.add_columns(pa.field("created_at", pa.timestamp("us", tz="UTC")))

        # Migrate: add ingestion-provenance columns if missing (existing rows get NULL)
        if "kind" not in schema.names:
            await memory_table.add_columns(
                [
                    pa.field("source", pa.string()),
                    pa.field("chunk_index", pa.int32()),
                    pa.field("kind", pa.string()),
                ]
            )
    else:
        memory_table = await db.create_table(
            name="memory",
            schema=_MEMORY_SCHEMA,
            mode="create",
        )

    return memory_table


async def _update_edges(table: AsyncTable, where: str, nodes: list[str], rels: list[str]) -> None:
    """Write the parallel edge lists (``connected_nodes`` / ``relationship_types``) for a row.

    LanceDB cannot assign a bare empty Python list to a ``list<string>`` column: it
    serialises to an untyped SQL ``[]`` and fails with "concat requires input of at least
    one array". When the lists are empty we emit a typed empty array via ``make_array()``
    instead; otherwise the values are passed through normally (LanceDB handles escaping).
    """
    if nodes:
        await table.update(updates={"connected_nodes": nodes, "relationship_types": rels}, where=where)
    else:
        await table.update(
            updates_sql={"connected_nodes": "make_array()", "relationship_types": "make_array()"},
            where=where,
        )


async def get_memory(
    query: str,
    bucket: str | None = None,
    namespace: str = "default",
    top_k: int = 5,
) -> list[dict]:
    """Retrieve the top_k most similar documents to the query from the vector store."""

    embedding = await get_embedding(query, mode="retrieval")
    table = await _get_memory_table()

    vector_query = await table.search(embedding, query_type="vector")

    where = f"namespace='{_sanitize(namespace, 'namespace')}'"
    if bucket is not None:
        # Scoping to a bucket is an explicit request for that document's chunks.
        where += f" AND bucket='{_sanitize(bucket, 'bucket')}'"
    else:
        # Global search returns curated facts only; ingested document rows would drown them out.
        where += f" AND {_EXCLUDE_INGESTED}"

    results = (
        await vector_query
        .where(where)
        .select(_RESULT_COLUMNS)
        .limit(top_k)
        .to_list()
    )  # fmt: skip

    return results


async def get_last_memories(
    n: int | None = 5,
    bucket: str | None = None,
    namespace: str = "default",
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Retrieve a page of memories ordered by creation time (most recent first).

    Skips *offset* of the most recent memories, then returns the next *n*. When *n* is
    ``None`` every memory after *offset* is returned (no upper bound). Memories without a
    ``created_at`` timestamp (pre-migration rows) are sorted last.

    Returns a ``(page, total)`` tuple where *total* is the number of memories matching
    the namespace/bucket filter, ignoring pagination.
    """

    table = await _get_memory_table()

    where = f"namespace='{_sanitize(namespace, 'namespace')}'"
    if bucket is not None:
        where += f" AND bucket='{_sanitize(bucket, 'bucket')}'"
    else:
        # Keep the global recent-memories view free of ingested document rows.
        where += f" AND {_EXCLUDE_INGESTED}"

    results = (
        await table.query()
        .where(where)
        .select(_RESULT_COLUMNS)
        .to_list()
    )  # fmt: skip

    # Most recent first; pre-migration rows without created_at sort last
    results.sort(key=lambda r: r.get("created_at") or datetime.min.replace(tzinfo=UTC), reverse=True)

    page = results[offset:] if n is None else results[offset : offset + n]
    return page, len(results)


async def add_memory(
    content: str,
    bucket: str | None = None,
    namespace: str = "default",
    connected_nodes: list[str] | None = None,
    relationship_types: list[str] | None = None,
    source: str | None = None,
    chunk_index: int | None = None,
    kind: str | None = None,
) -> UUID:
    """Add new documents to the vector store with their embeddings.

    *source*, *chunk_index*, and *kind* carry document-ingestion provenance and are NULL
    for ordinary memories.
    """

    nodes = connected_nodes or []
    rels = relationship_types or []
    if len(nodes) != len(rels):
        raise ValueError("connected_nodes and relationship_types must have the same length")

    table = await _get_memory_table()

    memory_id = uuid4()

    embedding = await get_embedding(content, mode="storage")

    data = {
        "memory_id": memory_id.bytes,
        "content": content,
        "bucket": bucket if bucket is not None else "default",
        "namespace": namespace,
        "connected_nodes": nodes,
        "relationship_types": rels,
        "vector": embedding,
        "created_at": datetime.now(UTC),
        "source": source,
        "chunk_index": chunk_index,
        "kind": kind,
    }

    await table.add([data], mode="append")

    return memory_id


async def add_memories(
    items: list[dict],
    namespace: str = "default",
) -> list[UUID]:
    """Add multiple memories in a single batch.

    Each item in *items* must have a ``content`` key and optionally ``bucket``,
    ``connected_nodes``, ``relationship_types``, the ingestion-provenance fields
    ``source`` / ``chunk_index`` / ``kind``, and a pre-generated ``memory_id`` (a
    :class:`~uuid.UUID`; lets callers wire edges between items before they are stored).

    Embeddings are generated in a single batched API call for efficiency.
    """

    if not items:
        return []

    # Validate connected_nodes / relationship_types lengths
    for i, item in enumerate(items):
        nodes = item.get("connected_nodes") or []
        rels = item.get("relationship_types") or []
        if len(nodes) != len(rels):
            raise ValueError(f"Item {i}: connected_nodes and relationship_types must have the same length")

    contents = [item["content"] for item in items]
    embeddings = await get_embedding(contents, mode="storage")

    table = await _get_memory_table()
    now = datetime.now(UTC)
    ids: list[UUID] = []
    rows: list[dict] = []

    for item, embedding in zip(items, embeddings, strict=True):
        memory_id = item.get("memory_id") or uuid4()
        ids.append(memory_id)
        rows.append(
            {
                "memory_id": memory_id.bytes,
                "content": item["content"],
                "bucket": item.get("bucket") or "default",
                "namespace": namespace,
                "connected_nodes": item.get("connected_nodes") or [],
                "relationship_types": item.get("relationship_types") or [],
                "vector": embedding,
                "created_at": now,
                "source": item.get("source"),
                "chunk_index": item.get("chunk_index"),
                "kind": item.get("kind"),
            }
        )

    await table.add(rows, mode="append")

    return ids


async def delete_memory(
    memory_id: UUID,
    namespace: str = "default",
) -> None:
    """Delete a memory entry from the vector store by its ID.

    Also removes any incoming edges from other memories that reference
    this node in their ``connected_nodes`` lists.
    """

    table = await _get_memory_table()
    target_str = str(memory_id)

    # Remove incoming edges: scan all rows in the namespace for references to this memory
    all_rows = (
        await table.query()
        .where(f"namespace='{_sanitize(namespace, 'namespace')}'")
        .select(["memory_id", "connected_nodes", "relationship_types"])
        .to_list()
    )  # fmt: skip

    for row in all_rows:
        nodes: list[str] = list(row.get("connected_nodes") or [])
        if target_str not in nodes:
            continue
        rels: list[str] = list(row.get("relationship_types") or [])
        new_nodes = [n for n, r in zip(nodes, rels, strict=True) if n != target_str]
        new_rels = [r for n, r in zip(nodes, rels, strict=True) if n != target_str]
        row_id = row["memory_id"] if isinstance(row["memory_id"], UUID) else UUID(bytes=row["memory_id"])
        await _update_edges(
            table,
            f"memory_id=X'{row_id.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'",
            new_nodes,
            new_rels,
        )

    await table.delete(f"memory_id=X'{memory_id.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'")


async def clear_memories(
    bucket: str | None = None,
    namespace: str = "default",
) -> None:
    """Delete all memory entries from a specific bucket in the vector store."""

    table = await _get_memory_table()

    await table.delete(
        f"bucket='{_sanitize(bucket if bucket is not None else 'default', 'bucket')}' AND namespace='{_sanitize(namespace, 'namespace')}'"
    )


async def connect_memories(
    source_id: UUID,
    target_id: UUID,
    relationship_type: str,
    namespace: str = "default",
) -> None:
    """Create a directed edge from source to target with the given relationship type.

    The edge is stored on the *source* node by appending the target UUID and
    relationship label to its ``connected_nodes`` / ``relationship_types`` lists.
    """

    table = await _get_memory_table()

    # Fetch the source row
    rows = (
        await table.query()
        .where(f"memory_id=X'{source_id.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'")
        .select(["connected_nodes", "relationship_types"])
        .to_list()
    )  # fmt: skip

    if not rows:
        raise ValueError(f"Source memory {source_id} not found")

    existing_nodes: list[str] = list(rows[0].get("connected_nodes") or [])
    existing_rels: list[str] = list(rows[0].get("relationship_types") or [])

    target_str = str(target_id)
    if target_str in existing_nodes:
        idx = existing_nodes.index(target_str)
        if existing_rels[idx] == relationship_type:
            return  # edge already exists

    existing_nodes.append(target_str)
    existing_rels.append(relationship_type)

    await table.update(
        updates={"connected_nodes": existing_nodes, "relationship_types": existing_rels},
        where=f"memory_id=X'{source_id.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'",
    )


async def disconnect_memories(
    source_id: UUID,
    target_id: UUID,
    relationship_type: str | None = None,
    namespace: str = "default",
) -> None:
    """Remove edges from source to target.

    If *relationship_type* is given, only the matching edge is removed.
    Otherwise **all** edges from source to target are removed.
    """

    table = await _get_memory_table()

    rows = (
        await table.query()
        .where(f"memory_id=X'{source_id.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'")
        .select(["connected_nodes", "relationship_types"])
        .to_list()
    )  # fmt: skip

    if not rows:
        raise ValueError(f"Source memory {source_id} not found")

    existing_nodes: list[str] = list(rows[0].get("connected_nodes") or [])
    existing_rels: list[str] = list(rows[0].get("relationship_types") or [])

    target_str = str(target_id)
    new_nodes: list[str] = []
    new_rels: list[str] = []
    for node, rel in zip(existing_nodes, existing_rels, strict=True):
        if node == target_str and (relationship_type is None or rel == relationship_type):
            continue
        new_nodes.append(node)
        new_rels.append(rel)

    await _update_edges(
        table,
        f"memory_id=X'{source_id.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'",
        new_nodes,
        new_rels,
    )


async def get_connected(
    memory_id: UUID,
    namespace: str = "default",
    relationship_type: str | None = None,
    depth: int = 1,
) -> list[dict]:
    """Traverse the knowledge graph starting from *memory_id*.

    Returns connected memories up to *depth* hops away, optionally filtered by
    *relationship_type*.  Each result includes a ``_depth`` key indicating how
    many hops away the node is from the origin.
    """

    if depth < 1:
        raise ValueError("depth must be >= 1")

    table = await _get_memory_table()
    visited: set[str] = {str(memory_id)}
    result: list[dict] = []
    frontier: set[str] = {str(memory_id)}

    for current_depth in range(1, depth + 1):
        next_frontier: set[str] = set()
        for node_id_str in frontier:
            node_uuid = UUID(node_id_str)
            rows = (
                await table.query()
                .where(f"memory_id=X'{node_uuid.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'")
                .select(["connected_nodes", "relationship_types"])
                .to_list()
            )  # fmt: skip
            if not rows:
                continue

            nodes: list[str] = list(rows[0].get("connected_nodes") or [])
            rels: list[str] = list(rows[0].get("relationship_types") or [])

            for target_str, rel in zip(nodes, rels, strict=True):
                if target_str in visited:
                    continue
                if relationship_type is not None and rel != relationship_type:
                    continue
                visited.add(target_str)
                next_frontier.add(target_str)

        # Fetch full details for newly discovered nodes
        for target_str in next_frontier:
            target_uuid = UUID(target_str)
            detail_rows = (
                await table.query()
                .where(f"memory_id=X'{target_uuid.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'")
                .select(_RESULT_COLUMNS)
                .to_list()
            )  # fmt: skip
            for row in detail_rows:
                row["_depth"] = current_depth
                result.append(row)

        frontier = next_frontier
        if not frontier:
            break

    return result


async def buckets_list(
    namespace: str = "default",
) -> set[str]:
    """Retrieve the list of unique buckets from the memory table."""

    table = await _get_memory_table()

    results = (
        await table.query()
        .where(f"namespace='{_sanitize(namespace, 'namespace')}'")
        .select(["bucket", "namespace"])
        .to_list()
    )  # fmt: skip

    return {r["bucket"] for r in results}


async def get_chunk_contents(bucket: str, namespace: str = "default", source: str | None = None) -> list[str]:
    """Return the contents of a bucket's ingested chunk memories, ordered by ``chunk_index``.

    Used by the ingestion add-on to detect an unchanged re-ingest (content dedup). Returns
    an empty list when the bucket holds no chunks. When *source* is given the result is
    scoped to that document's chunks, so a bucket holding several ingested documents dedups
    each one independently.
    """

    table = await _get_memory_table()

    where = (
        f"bucket='{_sanitize(bucket, 'bucket')}' AND namespace='{_sanitize(namespace, 'namespace')}' AND kind='chunk'"
    )
    if source is not None:
        where += f" AND source={_sql_literal(source)}"

    rows = (
        await table.query()
        .where(where)
        .select(["content", "chunk_index"])
        .to_list()
    )  # fmt: skip

    rows.sort(key=lambda r: r["chunk_index"] if r.get("chunk_index") is not None else 0)
    return [r["content"] for r in rows]


async def get_id_bucket_map(namespace: str = "default") -> dict[str, str]:
    """Return a ``{memory_id: bucket}`` mapping for every memory in the namespace.

    Used to resolve which bucket a connected node lives in when rendering a
    per-bucket view, so edges crossing into other buckets can be labelled.
    """

    table = await _get_memory_table()

    rows = (
        await table.query()
        .where(f"namespace='{_sanitize(namespace, 'namespace')}'")
        .select(["memory_id", "bucket"])
        .to_list()
    )  # fmt: skip

    out: dict[str, str] = {}
    for r in rows:
        mid = r["memory_id"]
        out[str(mid if isinstance(mid, UUID) else UUID(bytes=mid))] = r["bucket"]
    return out


async def list_namespaces() -> set[str]:
    """Retrieve the set of distinct namespaces that exist in the memory table."""

    table = await _get_memory_table()
    results = await table.query().select(["namespace"]).to_list()
    return {r["namespace"] for r in results}


async def update_memory(
    memory_id: UUID,
    namespace: str = "default",
    content: str | None = None,
    bucket: str | None = None,
) -> None:
    """Update a memory's content and/or bucket.

    If *content* changes the embedding vector is regenerated.
    """

    table = await _get_memory_table()

    updates: dict = {}

    if content is not None:
        updates["content"] = content
        updates["vector"] = await get_embedding(content, mode="storage")

    if bucket is not None:
        updates["bucket"] = bucket

    if not updates:
        return

    await table.update(
        updates=updates,
        where=f"memory_id=X'{memory_id.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'",
    )


async def rename_bucket(
    old_name: str,
    new_name: str,
    namespace: str = "default",
) -> int:
    """Rename a bucket by updating every memory that belongs to it.

    Returns the number of memories affected.
    """

    table = await _get_memory_table()

    rows = (
        await table.query()
        .where(
            f"bucket='{_sanitize(old_name, 'bucket')}' AND namespace='{_sanitize(namespace, 'namespace')}'"
        )
        .select(["memory_id"])
        .to_list()
    )  # fmt: skip

    if not rows:
        return 0

    await table.update(
        updates={"bucket": new_name},
        where=f"bucket='{_sanitize(old_name, 'bucket')}' AND namespace='{_sanitize(namespace, 'namespace')}'",
    )

    return len(rows)
