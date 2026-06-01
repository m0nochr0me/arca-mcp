"""Source loaders: turn raw bytes into plain text, keyed by file extension.

Only text formats ship today. Additional formats (PDF, DOCX, HTML) register here as
optional extras without touching the rest of the pipeline.
"""

from collections.abc import Callable
from pathlib import PurePosixPath


class UnsupportedFormat(ValueError):
    """Raised when no loader is registered for a source's extension."""


def _load_text(data: bytes) -> str:
    return data.decode("utf-8")


# Markdown is treated as plain text for now; semchunk splits on its structure well
# enough. A structure-aware markdown loader can replace this entry later.
_LOADERS: dict[str, Callable[[bytes], str]] = {
    ".txt": _load_text,
    ".md": _load_text,
    ".markdown": _load_text,
}


def supported_extensions() -> frozenset[str]:
    """Return the set of file extensions that have a registered loader."""
    return frozenset(_LOADERS)


def load(data: bytes | str, *, name: str) -> str:
    """Decode/parse a source into plain text.

    Args:
        data: Raw bytes to decode, or already-decoded text (returned unchanged).
        name: Source name (filename); its extension selects the loader.

    Raises:
        UnsupportedFormat: when *data* is bytes and the extension has no loader.
    """
    if isinstance(data, str):
        return data

    ext = PurePosixPath(name).suffix.lower()
    loader = _LOADERS.get(ext)
    if loader is None:
        raise UnsupportedFormat(f"No loader for {ext!r} (source {name!r})")
    return loader(data)
