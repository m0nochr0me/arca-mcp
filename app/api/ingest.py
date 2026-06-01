"""REST endpoints for the optional document-ingestion add-on.

The routes are always registered for discoverability; when the ``arca-ingest`` extra is
not installed they return ``501 Not Implemented``.
"""

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.api.deps import get_namespace, verify_token
from app.schema.ingest import IngestResponse, IngestTextRequest
from app.util.ingest import INGEST_AVAILABLE, UnsupportedFormat, ingest_document

router = APIRouter(prefix="/v1", tags=["ingest"], dependencies=[Depends(verify_token)])

_UNAVAILABLE = "Document ingestion add-on is not installed. Install the 'ingest' extra (uv sync --extra ingest)."


if INGEST_AVAILABLE:

    @router.post("/ingest", response_model=IngestResponse)
    async def ingest_file(
        file: UploadFile = File(..., description="Document to chunk and store (txt/md)"),
        bucket: str | None = Form(default=None),
        replace: bool = Form(default=False),
        namespace: str = Depends(get_namespace),
    ) -> IngestResponse:
        """Chunk an uploaded document and store the chunks as memories."""
        data = await file.read()
        try:
            result = await ingest_document(
                data, name=file.filename or "upload", bucket=bucket, namespace=namespace, replace=replace
            )
        except UnsupportedFormat as exc:
            raise HTTPException(status_code=415, detail=str(exc))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return IngestResponse(status="Document ingested", **result)

    @router.post("/ingest/text", response_model=IngestResponse)
    async def ingest_text(
        body: IngestTextRequest,
        namespace: str = Depends(get_namespace),
    ) -> IngestResponse:
        """Chunk raw document text and store the chunks as memories."""
        try:
            result = await ingest_document(
                body.text, name=body.source, bucket=body.bucket, namespace=namespace, replace=body.replace
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return IngestResponse(status="Document ingested", **result)

else:

    @router.post("/ingest", status_code=501)
    async def ingest_file_unavailable() -> None:
        raise HTTPException(status_code=501, detail=_UNAVAILABLE)

    @router.post("/ingest/text", status_code=501)
    async def ingest_text_unavailable() -> None:
        raise HTTPException(status_code=501, detail=_UNAVAILABLE)
