"""Data types shared across the ingest pipeline."""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Chunk:
    """A single chunk of a source document.

    Attributes:
        content: The chunk text.
        index: Zero-based position of the chunk within the source.
        start: Character offset of the chunk's first character in the source, if known.
        end: Character offset just past the chunk's last character in the source, if known.
    """

    content: str
    index: int
    start: int | None = None
    end: int | None = None
