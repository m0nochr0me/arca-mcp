"""
Request and response models for the Memory REST API.
"""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

# ---- Memory CRUD ----


class MemoryAddRequest(BaseModel):
    content: str = Field(..., description="Content to store in memory")
    bucket: str | None = Field(default=None, description="Optional bucket name")
    connected_nodes: list[str] | None = Field(
        default=None,
        description="Optional list of memory UUIDs this node connects to",
    )
    relationship_types: list[str] | None = Field(
        default=None,
        description="Parallel list of relationship labels (same length as connected_nodes)",
    )


class MemorySearchRequest(BaseModel):
    query: str = Field(..., description="Query to search in memory")
    bucket: str | None = Field(default=None, description="Optional bucket name")
    top_k: int = Field(default=5, ge=1, le=100, description="Number of top results to return")


class MemoryAddResponse(BaseModel):
    status: str
    memory_id: UUID


class MemorySearchResult(BaseModel):
    memory_id: UUID
    content: str
    bucket: str
    connected_nodes: list[str] = Field(default_factory=list)
    relationship_types: list[str] = Field(default_factory=list)

    model_config = ConfigDict(extra="ignore")


class MemorySearchResponse(BaseModel):
    status: str
    results: list[MemorySearchResult]


class MemoryDeleteResponse(BaseModel):
    status: str


class MemoryClearResponse(BaseModel):
    status: str


class BucketListResponse(BaseModel):
    buckets: list[str]


# ---- Knowledge-Graph edges ----


class ConnectRequest(BaseModel):
    source_id: UUID = Field(..., description="UUID of the source memory node")
    target_id: UUID = Field(..., description="UUID of the target memory node")
    relationship_type: str = Field(..., description="Label for the directed edge")


class DisconnectRequest(BaseModel):
    source_id: UUID = Field(..., description="UUID of the source memory node")
    target_id: UUID = Field(..., description="UUID of the target memory node")
    relationship_type: str | None = Field(
        default=None,
        description="If provided, only remove the edge with this label; otherwise remove all edges between src/dst",
    )


class ConnectedResult(BaseModel):
    memory_id: UUID
    content: str
    bucket: str
    connected_nodes: list[str] = Field(default_factory=list)
    relationship_types: list[str] = Field(default_factory=list)
    depth: int = Field(alias="_depth")

    model_config = ConfigDict(extra="ignore", populate_by_name=True)


class ConnectedResponse(BaseModel):
    status: str
    results: list[ConnectedResult]


class EdgeResponse(BaseModel):
    status: str
