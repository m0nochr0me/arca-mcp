"""
Memory management MCP server.
"""

from typing import Annotated, Any

from uuid import UUID
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers

from app.util.ingest import INGEST_AVAILABLE, ingest_document
from app.util.memory import (
    add_memory,
    buckets_list,
    clear_memories,
    connect_memories,
    delete_memory,
    disconnect_memories,
    get_connected,
    get_last_memories,
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
    connected_nodes: Annotated[list[str] | None, "Optional list of memory UUIDs this node connects to"] = None,
    relationship_types: Annotated[
        list[str] | None, "Parallel list of relationship labels (same length as connected_nodes)"
    ] = None,
) -> dict[str, str]:
    """
    Add content to memory storage, optionally with initial graph edges.

    Args:
        content: Content to store in memory
        bucket: Optional bucket name
        connected_nodes: Optional list of memory UUID strings to connect to
        relationship_types: Parallel list of relationship labels

    Returns:
        dict[str, str]: The UUID of the stored memory item.
    """
    namespace = _get_namespace()
    memory_id = await add_memory(content, bucket, namespace, connected_nodes, relationship_types)
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
async def get_last(
    n: Annotated[int, "Number of recent memories to return"] = 5,
    bucket: Annotated[str | None, "Optional bucket name"] = None,
) -> dict[str, Any]:
    """
    Retrieve the last N memories ordered by creation time (most recent first).

    Args:
        n: Number of recent memories to return (default 5)
        bucket: Optional bucket name to filter by

    Returns:
        dict[str, Any]: The retrieved memory items.
    """
    namespace = _get_namespace()
    results, _ = await get_last_memories(n, bucket, namespace)

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


# ---- Knowledge-graph tools ----


@server.tool(tags={"memory", "graph"})
async def connect(
    source_id: Annotated[str, "UUID of the source memory node"],
    target_id: Annotated[str, "UUID of the target memory node"],
    relationship_type: Annotated[str, "Label for the directed edge (e.g. 'related_to', 'depends_on')"],
) -> dict[str, str]:
    """
    Create a directed edge between two memory nodes.

    Args:
        source_id: UUID of the source memory
        target_id: UUID of the target memory
        relationship_type: Label describing the relationship

    Returns:
        dict[str, str]: Status message.
    """
    namespace = _get_namespace()
    await connect_memories(UUID(source_id), UUID(target_id), relationship_type, namespace)
    return {"status": "Memories connected"}


@server.tool(tags={"memory", "graph"})
async def disconnect(
    source_id: Annotated[str, "UUID of the source memory node"],
    target_id: Annotated[str, "UUID of the target memory node"],
    relationship_type: Annotated[str | None, "Remove only this edge label; omit to remove all edges"] = None,
) -> dict[str, str]:
    """
    Remove one or all directed edges between two memory nodes.

    Args:
        source_id: UUID of the source memory
        target_id: UUID of the target memory
        relationship_type: If given, only remove the matching edge

    Returns:
        dict[str, str]: Status message.
    """
    namespace = _get_namespace()
    await disconnect_memories(UUID(source_id), UUID(target_id), relationship_type, namespace)
    return {"status": "Memories disconnected"}


@server.tool(tags={"memory", "graph"})
async def traverse(
    memory_id: Annotated[str, "UUID of the starting memory node"],
    relationship_type: Annotated[str | None, "Filter traversal to this relationship type"] = None,
    depth: Annotated[int, "How many hops to traverse (default 1)"] = 1,
) -> dict[str, Any]:
    """
    Traverse the knowledge graph starting from a memory node.

    Returns connected memories up to *depth* hops away, optionally filtered
    by relationship type.

    Args:
        memory_id: UUID of the starting memory
        relationship_type: Optional edge-label filter
        depth: Number of hops (1 = direct neighbours only)

    Returns:
        dict: Status and list of connected memory nodes with depth info.
    """
    namespace = _get_namespace()
    results = await get_connected(UUID(memory_id), namespace, relationship_type, depth)
    return {
        "status": "Graph traversed" if results else "No connected nodes found",
        "results": results,
    }


# ---- Document ingestion (optional add-on) ----


if INGEST_AVAILABLE:

    @server.tool(tags={"memory", "ingest"})
    async def ingest(
        text: Annotated[str, "Document text to chunk and store"],
        source: Annotated[str, "Source name; seeds the bucket name"],
        bucket: Annotated[str | None, "Override bucket (defaults to a name derived from source)"] = None,
        replace: Annotated[bool, "Clear the target bucket before ingesting"] = False,
        parent: Annotated[bool, "Create a parent node the chunks attach to"] = True,
        parent_content: Annotated[str | None, "Content for the parent node (defaults to source)"] = None,
    ) -> dict[str, Any]:
        """
        Chunk a document and store the chunks as memories.

        Splits *text* into semantically coherent chunks and stores each as a memory in a
        per-document bucket (derived from *source* unless *bucket* is given). Set *replace*
        to clear the bucket first for idempotent re-ingestion. When *parent* is set a node
        (content *parent_content*, defaulting to *source*) anchors the chunks via ``part_of``.

        Args:
            text: Document text to chunk and store
            source: Source name; seeds the bucket name
            bucket: Optional explicit bucket name
            replace: Clear the target bucket before ingesting
            parent: Create a parent node the chunks attach to
            parent_content: Content for the parent node (defaults to source)

        Returns:
            dict: status, bucket, chunk count, the stored memory UUIDs, and the parent id.
        """
        namespace = _get_namespace()
        result = await ingest_document(
            text,
            name=source,
            bucket=bucket,
            namespace=namespace,
            replace=replace,
            parent=parent,
            parent_content=parent_content,
        )
        return {
            "status": "Document unchanged" if result["skipped"] else "Document ingested",
            "bucket": result["bucket"],
            "chunks": result["chunks"],
            "memory_ids": [str(m) for m in result["memory_ids"]],
            "skipped": result["skipped"],
            "parent_id": result["parent_id"],
        }
