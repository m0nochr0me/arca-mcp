"""Request and response models for the document-ingestion endpoints."""

from uuid import UUID

from pydantic import BaseModel, Field


class IngestTextRequest(BaseModel):
    text: str = Field(..., description="Document text to chunk and store")
    source: str = Field(..., description="Source name; seeds the bucket and selects the loader")
    bucket: str | None = Field(default=None, description="Override bucket (defaults to a name derived from source)")
    replace: bool = Field(default=False, description="Clear the target bucket before ingesting")


class IngestResponse(BaseModel):
    status: str
    bucket: str
    chunks: int
    memory_ids: list[UUID]
