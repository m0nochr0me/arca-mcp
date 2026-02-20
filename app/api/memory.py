"""
REST API router for memory operations.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_namespace, verify_token
from app.schema.memory import (
    BucketListResponse,
    ConnectedResponse,
    ConnectedResult,
    ConnectRequest,
    DisconnectRequest,
    EdgeResponse,
    MemoryAddRequest,
    MemoryAddResponse,
    MemoryClearResponse,
    MemoryDeleteResponse,
    MemorySearchRequest,
    MemorySearchResponse,
    MemorySearchResult,
)
from app.util.memory import (
    add_memory,
    buckets_list,
    clear_memories,
    connect_memories,
    delete_memory,
    disconnect_memories,
    get_connected,
    get_memory,
)

router = APIRouter(
    prefix="/v1",
    tags=["memory"],
    dependencies=[Depends(verify_token)],
)


@router.post(
    "/memories",
    response_model=MemoryAddResponse,
)
async def create_memory(
    body: MemoryAddRequest,
    namespace: str = Depends(get_namespace),
) -> MemoryAddResponse:
    """Add content to memory storage."""
    memory_id = await add_memory(body.content, body.bucket, namespace, body.connected_nodes, body.relationship_types)
    return MemoryAddResponse(status="Memory added", memory_id=memory_id)


@router.post(
    "/memories/search",
    response_model=MemorySearchResponse,
)
async def search_memories(
    body: MemorySearchRequest,
    namespace: str = Depends(get_namespace),
) -> MemorySearchResponse:
    """Search memories using semantic similarity."""
    results = await get_memory(body.query, body.bucket, namespace, top_k=body.top_k)
    return MemorySearchResponse(
        status="Memory retrieved" if results else "No memory found",
        results=[MemorySearchResult.model_validate(r) for r in results],
    )


@router.delete(
    "/memories/{memory_id}",
    response_model=MemoryDeleteResponse,
)
async def remove_memory(
    memory_id: UUID,
    namespace: str = Depends(get_namespace),
) -> MemoryDeleteResponse:
    """Delete a specific memory by its UUID."""
    await delete_memory(memory_id, namespace)
    return MemoryDeleteResponse(status="Memory deleted")


@router.delete(
    "/memories",
    response_model=MemoryClearResponse,
)
async def clear_bucket(
    bucket: str | None = Query(
        default=None,
        description="Bucket to clear. If omitted, clears the default bucket.",
    ),
    namespace: str = Depends(get_namespace),
) -> MemoryClearResponse:
    """Clear all memories, optionally scoped to a bucket."""
    await clear_memories(bucket, namespace)
    return MemoryClearResponse(status="Memories cleared")


@router.get(
    "/buckets",
    response_model=BucketListResponse,
)
async def list_buckets(
    namespace: str = Depends(get_namespace),
) -> BucketListResponse:
    """List all memory buckets in the namespace."""
    buckets = await buckets_list(namespace)
    return BucketListResponse(buckets=sorted(buckets))


# ---- Knowledge-graph endpoints ----


@router.post(
    "/memories/connect",
    response_model=EdgeResponse,
)
async def connect_nodes(
    body: ConnectRequest,
    namespace: str = Depends(get_namespace),
) -> EdgeResponse:
    """Create a directed edge between two memory nodes."""
    await connect_memories(body.source_id, body.target_id, body.relationship_type, namespace)
    return EdgeResponse(status="Memories connected")


@router.post(
    "/memories/disconnect",
    response_model=EdgeResponse,
)
async def disconnect_nodes(
    body: DisconnectRequest,
    namespace: str = Depends(get_namespace),
) -> EdgeResponse:
    """Remove edges between two memory nodes."""
    await disconnect_memories(body.source_id, body.target_id, body.relationship_type, namespace)
    return EdgeResponse(status="Memories disconnected")


@router.get(
    "/memories/{memory_id}/connected",
    response_model=ConnectedResponse,
)
async def get_connected_nodes(
    memory_id: UUID,
    namespace: str = Depends(get_namespace),
    relationship_type: str | None = Query(default=None, description="Filter by relationship type"),
    depth: int = Query(default=1, ge=1, le=10, description="Number of hops to traverse"),
) -> ConnectedResponse:
    """Traverse the knowledge graph from a starting memory node."""
    results = await get_connected(memory_id, namespace, relationship_type, depth)
    return ConnectedResponse(
        status="Graph traversed" if results else "No connected nodes found",
        results=[ConnectedResult.model_validate(r) for r in results],
    )
