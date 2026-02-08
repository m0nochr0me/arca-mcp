"""
REST API router for memory operations.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_namespace, verify_token
from app.schema.memory import (
    BucketListResponse,
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
    delete_memory,
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
    memory_id = await add_memory(body.content, body.bucket, namespace)
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
