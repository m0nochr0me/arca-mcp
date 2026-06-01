"""arca-ingest: optional document loading and chunking add-on for Arca MCP.

Transport-agnostic library: it turns a source document into chunks and nothing more
(no embedding, no storage, no server imports). The Arca server consumes it in-process.
"""

from collections.abc import Callable

from arca_ingest.chunker import DEFAULT_CHUNK_SIZE, DEFAULT_OVERLAP, chunk_text
from arca_ingest.loaders import UnsupportedFormat, load, supported_extensions
from arca_ingest.types import Chunk

__all__ = [
    "Chunk",
    "UnsupportedFormat",
    "chunk_text",
    "ingest",
    "load",
    "supported_extensions",
]

__version__ = "0.1.0"


def ingest(
    data: bytes | str,
    *,
    name: str,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    overlap: float | int = DEFAULT_OVERLAP,
    token_counter: Callable[[str], int] | None = None,
) -> list[Chunk]:
    """Load a source into text, then chunk it -- the single call the server uses.

    Args:
        data: Raw bytes to decode by extension, or already-decoded text.
        name: Source name (filename); its extension selects the loader.
        chunk_size: Maximum chunk length in token-counter units.
        overlap: Chunk overlap (ratio of *chunk_size* when ``< 1``, else absolute count).
        token_counter: Length function; defaults to a whitespace word count.

    Returns:
        Chunks in source order.
    """
    text = load(data, name=name)
    return chunk_text(text, chunk_size=chunk_size, overlap=overlap, token_counter=token_counter)
