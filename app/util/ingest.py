"""Server-side glue for the optional document-ingestion add-on.

Bridges the transport-agnostic ``arca_ingest`` library to the memory core: it chunks a
document and stores the chunks as memories via :func:`add_memories`. This is only
functional when the ``arca-ingest`` package is installed (the ``ingest`` extra);
otherwise :data:`INGEST_AVAILABLE` is ``False`` and the front doors return ``501``.
"""

import re
from collections.abc import Callable
from functools import lru_cache
from pathlib import PurePosixPath

from app.core.config import settings
from app.core.log import logger
from app.util.memory import _sanitize, add_memories, clear_memories

try:
    import arca_ingest
    from arca_ingest import UnsupportedFormat

    INGEST_AVAILABLE = True
except ImportError:
    INGEST_AVAILABLE = False

    class UnsupportedFormat(Exception):  # type: ignore[no-redef]
        """Placeholder so importers can reference the symbol when the add-on is absent."""


_EMBED_BATCH = 100  # matches the add_memories / Gemini embed-call cap


@lru_cache(maxsize=1)
def _token_counter() -> Callable[[str], int] | None:
    """Return an accurate local Gemini token counter, or ``None`` for the word counter.

    Uses google-genai's ``LocalTokenizer``, which downloads a SentencePiece model once
    and then counts offline -- fast enough for semchunk's recursive splitting (unlike the
    API-based ``count_tokens``). The embedding model isn't in the tokenizer map, so a
    generative Gemini model is used as a close proxy. Any failure (missing
    ``sentencepiece``, no network) degrades to ``arca_ingest``'s word counter.
    """
    try:
        from google.genai.local_tokenizer import LocalTokenizer

        tokenizer = LocalTokenizer(settings.INGEST_TOKENIZER_MODEL)
        tokenizer.count_tokens("warmup")  # force the one-time model download/validation now
        return lambda text: tokenizer.count_tokens(text).total_tokens
    except Exception as exc:  # noqa: BLE001 - degrade gracefully, never block ingestion
        logger.warning(f"Gemini LocalTokenizer unavailable; using word-count chunking ({exc})")
        return None


def _bucket_for(source: str) -> str:
    """Derive a sanitizer-safe bucket name from a source/filename."""
    stem = PurePosixPath(source).stem or source
    cleaned = re.sub(r"[^\w\-. ]+", "_", stem).strip()
    return cleaned or "ingested"


async def ingest_document(
    data: bytes | str,
    *,
    name: str,
    bucket: str | None,
    namespace: str,
    replace: bool,
) -> dict:
    """Chunk *data* and store the chunks as memories in a per-document bucket.

    Args:
        data: Raw document bytes (decoded by extension) or already-decoded text.
        name: Source name/filename; selects the loader and seeds the bucket name.
        bucket: Explicit bucket; defaults to a name derived from *name*.
        namespace: Tenant namespace.
        replace: Clear the target bucket before storing (idempotent re-ingestion).

    Returns:
        ``{"bucket": str, "chunks": int, "memory_ids": list[UUID]}``.

    Raises:
        UnsupportedFormat: the source extension has no loader.
        ValueError: the document exceeds ``INGEST_MAX_CHUNKS``.
    """
    chunks = arca_ingest.ingest(
        data,
        name=name,
        chunk_size=settings.INGEST_CHUNK_SIZE,
        overlap=settings.INGEST_CHUNK_OVERLAP,
        token_counter=_token_counter(),
    )

    if len(chunks) > settings.INGEST_MAX_CHUNKS:
        raise ValueError(
            f"Document produced {len(chunks)} chunks, exceeding INGEST_MAX_CHUNKS={settings.INGEST_MAX_CHUNKS}"
        )

    target = _sanitize(bucket or _bucket_for(name), "bucket")

    if replace:
        await clear_memories(target, namespace)

    memory_ids = []
    for start in range(0, len(chunks), _EMBED_BATCH):
        items = [{"content": chunk.content, "bucket": target} for chunk in chunks[start : start + _EMBED_BATCH]]
        memory_ids.extend(await add_memories(items, namespace))

    return {"bucket": target, "chunks": len(chunks), "memory_ids": memory_ids}
