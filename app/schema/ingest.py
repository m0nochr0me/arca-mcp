"""Request and response models for the document-ingestion endpoints."""

from uuid import UUID

from pydantic import BaseModel, Field


class IngestTextRequest(BaseModel):
    text: str = Field(..., description="Document text to chunk and store")
    source: str = Field(..., description="Source name; seeds the bucket and selects the loader")
    bucket: str | None = Field(default=None, description="Override bucket (defaults to a name derived from source)")
    replace: bool = Field(default=False, description="Clear the target bucket before ingesting")
    parent: bool = Field(default=True, description="Create a parent node the chunks attach to")
    parent_content: str | None = Field(default=None, description="Content for the parent node (defaults to source)")
    parent_id: UUID | None = Field(
        default=None, description="Attach chunks to this existing node instead of creating one"
    )


class IngestResponse(BaseModel):
    status: str
    bucket: str
    chunks: int
    memory_ids: list[UUID]
    skipped: bool = Field(default=False, description="True when an identical document was already ingested (no-op)")
    parent_id: UUID | None = Field(default=None, description="The parent/anchor node the chunks attach to, if any")


class IngestFormatsResponse(BaseModel):
    available: bool = Field(..., description="Whether the ingestion add-on is installed")
    extensions: list[str] = Field(
        default_factory=list, description="File extensions the installed loaders accept (e.g. '.txt', '.pdf')"
    )
