"""
Memory management MCP server.
"""

from typing import Annotated, Any

from click import UUID
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers

from app.util.memory import (
    add_memory,
    buckets_list,
    clear_memories,
    delete_memory,
    get_memory,
)

__all__ = ["server"]

server = FastMCP("Memory Tools")


def _get_namespace() -> str:
    """Extract namespace from headers or use default."""
    headers = get_http_headers()
    return headers.get("x-namespace", "default")


@server.tool(tags={"memory"})
async def add(
    content: Annotated[str, "Content to store in memory"],
    bucket: Annotated[str | None, "Optional bucket name"] = None,
) -> dict[str, str]:
    """
    Add content to memory storage.

    Args:
        content: Content to store in memory
        bucket: Optional bucket name

    Returns:
        dict[str, str]: The UUID of the stored memory item.
    """
    namespace = _get_namespace()
    memory_id = await add_memory(content, bucket, namespace)
    return {
        "status": "Memory added",
        "memory_id": str(memory_id),
    }


@server.tool(tags={"memory"})
async def get(
    query: Annotated[str, "Query to search in memory"],
    bucket: Annotated[str | None, "Optional bucket name"] = None,
    top_k: Annotated[int, "Number of top results to return"] = 5,
) -> dict[str, Any] | None:
    """
    Retrieve content from memory storage based on a query.
    Args:
        query: Query to search in memory
        bucket: Optional bucket name
        top_k: Number of top results to return
    Returns:
        dict[str, Any] | None: The retrieved memory item or None if not found.
    """
    namespace = _get_namespace()
    results = await get_memory(query, bucket, namespace, top_k=top_k)

    return {
        "status": "Memory retrieved" if results else "No memory found",
        "results": results,
    }


@server.tool(tags={"memory"})
async def delete(
    memory_id: Annotated[str, "UUID of the memory item to delete"],
) -> dict[str, str]:
    """
    Delete a memory item by its UUID.

    Args:
        memory_id: UUID of the memory item to delete

    Returns:
        dict[str, str]: Status message.
    """
    namespace = _get_namespace()
    await delete_memory(UUID(memory_id), namespace)
    return {
        "status": "Memory deleted",
    }


@server.tool(tags={"memory"})
async def clear(
    bucket: Annotated[str | None, "Optional bucket name to clear"] = None,
) -> dict[str, str]:
    """
    Clear all memory items, optionally within a specific bucket.

    Args:
        bucket: Optional bucket name to clear
    Returns:
        dict[str, str]: Status message.
    """
    namespace = _get_namespace()
    await clear_memories(bucket, namespace)
    return {
        "status": "Memories cleared",
    }


@server.tool(tags={"memory"})
async def list_buckets() -> dict[str, list[str]]:
    """
    List all memory buckets.

    Returns:
        dict[str, list[str]]: List of bucket names.
    """
    namespace = _get_namespace()
    buckets = await buckets_list(namespace)
    return {
        "buckets": list(buckets),
    }
