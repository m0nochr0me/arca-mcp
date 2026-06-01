"""Server-side glue for the optional document-ingestion add-on.

Bridges the transport-agnostic ``arca_ingest`` library to the memory core: it chunks a
document and stores the chunks as memories via :func:`add_memories`. This is only
functional when the ``arca-ingest`` package is installed (the ``ingest`` extra);
otherwise :data:`INGEST_AVAILABLE` is ``False`` and the front doors return ``501``.
"""

import hashlib
import re
from collections.abc import Callable
from functools import lru_cache
from pathlib import PurePosixPath
from uuid import UUID, uuid4

from app.core.config import settings
from app.core.log import logger
from app.util.memory import _sanitize, add_memories, add_memory, clear_memories, get_chunk_contents

try:
    import arca_ingest
    from arca_ingest import UnsupportedFormat

    INGEST_AVAILABLE = True
except ImportError:
    INGEST_AVAILABLE = False

    class UnsupportedFormat(Exception):  # type: ignore[no-redef]
        """Placeholder so importers can reference the symbol when the add-on is absent."""


_EMBED_BATCH = 100  # matches the add_memories / Gemini embed-call cap


def supported_extensions() -> list[str]:
    """Sorted file extensions the installed loaders accept (empty when the add-on is absent).

    Reflects which optional format parsers are importable in this environment, so callers
    (e.g. the web UI) can offer exactly the formats that will actually ingest.
    """
    if not INGEST_AVAILABLE:
        return []
    return sorted(arca_ingest.supported_extensions())


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


def _digest(contents: list[str]) -> str:
    """Order-sensitive content hash over a list of chunk texts (for re-ingest dedup)."""
    h = hashlib.sha256()
    for content in contents:
        h.update(content.encode("utf-8"))
        h.update(b"\x00")  # delimiter so chunk boundaries are part of the digest
    return h.hexdigest()


async def ingest_document(
    data: bytes | str,
    *,
    name: str,
    bucket: str | None,
    namespace: str,
    replace: bool,
) -> dict:
    """Chunk *data* and store the chunks as memories in a per-document bucket.

    Each document maps to one bucket holding a ``kind="document"`` anchor node plus the
    chunk memories. Every chunk carries provenance (``source`` / ``chunk_index``) and two
    graph edges: ``part_of`` → the anchor and ``next`` → the following chunk.

    Re-ingesting byte-identical content into the same bucket is a no-op (``skipped``),
    unless *replace* is set, in which case the bucket is cleared and rebuilt.

    Args:
        data: Raw document bytes (decoded by extension) or already-decoded text.
        name: Source name/filename; selects the loader and seeds the bucket name.
        bucket: Explicit bucket; defaults to a name derived from *name*.
        namespace: Tenant namespace.
        replace: Clear the target bucket before storing.

    Returns:
        ``{"bucket": str, "chunks": int, "memory_ids": list[UUID], "skipped": bool}``.

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

    # Empty/whitespace document: nothing to store, and no anchor to orphan.
    if not chunks:
        return {"bucket": target, "chunks": 0, "memory_ids": [], "skipped": False}

    new_contents = [chunk.content for chunk in chunks]

    if replace:
        await clear_memories(target, namespace)
    else:
        # Dedup: an identical document already in this bucket needs no re-embedding.
        existing = await get_chunk_contents(target, namespace)
        if existing and _digest(existing) == _digest(new_contents):
            return {"bucket": target, "chunks": len(chunks), "memory_ids": [], "skipped": True}

    # Anchor node the chunks hang off of (one per document). Created first so chunks can
    # reference its id via the ``part_of`` edge.
    anchor_id = await add_memory(content=name, bucket=target, namespace=namespace, source=name, kind="document")

    # Pre-generate chunk ids so each row can carry its ``next`` edge at insert time,
    # avoiding a second read-modify-write pass per chunk.
    chunk_ids = [uuid4() for _ in chunks]

    memory_ids: list[UUID] = []
    for start in range(0, len(chunks), _EMBED_BATCH):
        items = []
        for chunk in chunks[start : start + _EMBED_BATCH]:
            nodes = [str(anchor_id)]
            rels = ["part_of"]
            if chunk.index + 1 < len(chunks):
                nodes.append(str(chunk_ids[chunk.index + 1]))
                rels.append("next")
            items.append(
                {
                    "memory_id": chunk_ids[chunk.index],
                    "content": chunk.content,
                    "bucket": target,
                    "source": name,
                    "chunk_index": chunk.index,
                    "kind": "chunk",
                    "connected_nodes": nodes,
                    "relationship_types": rels,
                }
            )
        memory_ids.extend(await add_memories(items, namespace))

    return {"bucket": target, "chunks": len(chunks), "memory_ids": memory_ids, "skipped": False}
