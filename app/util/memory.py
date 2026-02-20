"""
Utility functions for memory storage and retrieval using LanceDB.
"""

import re
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


__all__ = (
    "add_memory",
    "buckets_list",
    "clear_memories",
    "connect_memories",
    "delete_memory",
    "disconnect_memories",
    "get_connected",
    "get_memory",
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
    ]
)


async def _get_memory_table() -> AsyncTable:
    """Get the LanceDB table for memory storage."""
    db = await get_db()
    memory_table = await db.create_table(
        name="memory",
        schema=_MEMORY_SCHEMA,
        mode="create",
        exist_ok=True,
    )
    return memory_table


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

    if bucket is not None:
        vector_query = vector_query.where(f"bucket='{_sanitize(bucket, 'bucket')}'")

    results = (
        await vector_query
        .where(f"namespace='{_sanitize(namespace, 'namespace')}'")
        .select(["memory_id", "content", "bucket", "connected_nodes", "relationship_types"])
        .limit(top_k)
        .to_list()
    )  # fmt: skip

    return results


async def add_memory(
    content: str,
    bucket: str | None = None,
    namespace: str = "default",
    connected_nodes: list[str] | None = None,
    relationship_types: list[str] | None = None,
) -> UUID:
    """Add new documents to the vector store with their embeddings."""

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
    }

    await table.add([data], mode="append")

    return memory_id


async def delete_memory(
    memory_id: UUID,
    namespace: str = "default",
) -> None:
    """Delete a memory entry from the vector store by its ID."""

    table = await _get_memory_table()

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

    await table.update(
        updates={"connected_nodes": new_nodes, "relationship_types": new_rels},
        where=f"memory_id=X'{source_id.hex}' AND namespace='{_sanitize(namespace, 'namespace')}'",
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
                .select(["memory_id", "content", "bucket", "connected_nodes", "relationship_types"])
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
