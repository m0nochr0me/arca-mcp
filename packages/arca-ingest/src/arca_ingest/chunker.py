"""Chunking: split plain text into ordered chunks via semchunk.

Chunk sizes are expressed in whatever unit the *token counter* measures. The default
counter is a dependency-free word count -- a conservative proxy for model tokens (text
has at least as many tokens as whitespace-delimited words), so a word-based size sits
comfortably under an embedder's token ceiling. Swap in a real tokenizer (e.g. tiktoken)
for token-accurate sizing.
"""

from collections.abc import Callable

import semchunk

from arca_ingest.types import Chunk

DEFAULT_CHUNK_SIZE = 512
DEFAULT_OVERLAP: float | int = 0.1


def _default_token_counter(text: str) -> int:
    return len(text.split())


def chunk_text(
    text: str,
    *,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    overlap: float | int = DEFAULT_OVERLAP,
    token_counter: Callable[[str], int] | None = None,
) -> list[Chunk]:
    """Split *text* into ordered chunks.

    Args:
        text: The text to chunk. Leading/trailing whitespace is stripped; empty input
            yields an empty list.
        chunk_size: Maximum chunk length in token-counter units.
        overlap: Chunk overlap -- a ratio of *chunk_size* when ``< 1``, else an absolute
            count in token-counter units.
        token_counter: Length function; defaults to a whitespace word count.

    Returns:
        Chunks in source order, each carrying its index and character offsets.
    """
    text = text.strip()
    if not text:
        return []

    counter = token_counter or _default_token_counter
    chunker = semchunk.chunkerify(counter, chunk_size)
    chunks, offsets = chunker(text, offsets=True, overlap=overlap)

    return [
        Chunk(content=content, index=i, start=start, end=end)
        for i, (content, (start, end)) in enumerate(zip(chunks, offsets, strict=True))
    ]
