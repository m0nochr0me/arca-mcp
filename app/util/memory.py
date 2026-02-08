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


def _sanitize(value: str, name: str) -> str:
    """Validate that a value is safe to interpolate into a SQL filter."""
    if not _SAFE_IDENTIFIER.match(value):
        raise ValueError(f"Invalid {name}: {value!r}")
    return value


__all__ = (
    "add_memory",
    "buckets_list",
    "clear_memories",
    "delete_memory",
    "get_memory",
)

_MEMORY_SCHEMA = pa.schema([
    ("memory_id", pa.uuid()),
    ("content", pa.large_string()),
    ("bucket", pa.string()),
    ("namespace", pa.string()),
    ("vector", pa.list_(pa.float32(), list_size=settings.EMBEDDING_DIMENSION)),
])


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
        .select(["memory_id", "content", "bucket"])
        .limit(top_k)
        .to_list()
    )  # fmt: skip

    return results


async def add_memory(
    content: str,
    bucket: str | None = None,
    namespace: str = "default",
) -> UUID:
    """Add new documents to the vector store with their embeddings."""

    table = await _get_memory_table()

    memory_id = uuid4()

    data = {
        "memory_id": memory_id.bytes,
        "content": content,
        "bucket": bucket if bucket is not None else "default",
        "namespace": namespace,
        "vector": None,
    }

    embedding = await get_embedding(content, mode="storage")

    data |= {"vector": embedding}

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
