"""Source loaders: turn raw bytes into text, keyed by file extension.

Text formats (``.txt`` / ``.md``) are always available. Richer formats -- PDF, DOCX,
HTML, EPUB, FB2 -- each need an optional parser and ship as ``arca-ingest`` extras
(``arca-ingest[pdf]`` and so on). A format whose parser isn't installed is simply absent
from :func:`supported_extensions`; loading it raises :class:`UnsupportedFormat` with a
hint naming the extra to install. Parser imports are lazy (inside each loader), so merely
importing this module never pulls a heavy dependency.

Structured formats (HTML, EPUB, DOCX) are rendered as Markdown rather than flattened to
plain text, so headings, lists, tables, and link targets survive into the stored chunks.
"""

import importlib.util
import io
import re
from collections.abc import Callable
from pathlib import PurePosixPath
from typing import NamedTuple


class UnsupportedFormat(ValueError):
    """Raised when no loader is registered (or installed) for a source's extension."""


def _load_text(data: bytes) -> str:
    return data.decode("utf-8")


def _html_to_md(markup: bytes | str) -> str:
    """Render an HTML/XHTML fragment as Markdown (shared by HTML, EPUB, and DOCX)."""
    from bs4 import BeautifulSoup
    from markdownify import markdownify

    soup = BeautifulSoup(markup, "html.parser")
    for tag in soup(("script", "style")):
        tag.decompose()
    markdown = markdownify(str(soup), heading_style="ATX")
    return re.sub(r"\n{3,}", "\n\n", markdown).strip()


def _load_html(data: bytes) -> str:
    return _html_to_md(data)


def _load_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return "\n\n".join(page.extract_text() or "" for page in reader.pages)


def _load_docx(data: bytes) -> str:
    import mammoth

    # mammoth maps Word styles to semantic HTML (headings, lists, tables); the shared
    # HTML->Markdown pass then renders that structure. python-docx's paragraph join was
    # dropped because it silently lost tables.
    html = mammoth.convert_to_html(io.BytesIO(data)).value
    return _html_to_md(html)


def _load_epub(data: bytes) -> str:
    import ebooklib
    from ebooklib import epub

    book = epub.read_epub(io.BytesIO(data))
    # Spine order is the reading order; fall back to manifest order if the spine is empty.
    items = [book.get_item_with_id(idref) for idref, _ in book.spine]
    items = [item for item in items if item is not None]
    if not items:
        items = list(book.get_items_of_type(ebooklib.ITEM_DOCUMENT))
    return "\n\n".join(_html_to_md(item.get_content()) for item in items)


# FB2 block-level tags whose text we keep: paragraphs, verse lines, subtitles, signatures.
_FB2_BLOCK_TAGS = frozenset({"p", "v", "subtitle", "text-author"})


def _load_fb2(data: bytes) -> str:
    # defusedxml hardens against entity-expansion / external-entity attacks in uploads.
    from defusedxml.ElementTree import fromstring

    root = fromstring(data)
    parts: list[str] = []
    for body in root:
        if body.tag.rsplit("}", 1)[-1] != "body":  # skip <description>, <binary>, ...
            continue
        for elem in body.iter():
            if elem.tag.rsplit("}", 1)[-1] in _FB2_BLOCK_TAGS:
                text = "".join(elem.itertext()).strip()
                if text:
                    parts.append(text)
    return "\n".join(parts)


_LOADERS: dict[str, Callable[[bytes], str]] = {
    # Markdown is treated as plain text for now; semchunk splits on its structure well
    # enough. A structure-aware markdown loader can replace these entries later.
    ".txt": _load_text,
    ".md": _load_text,
    ".markdown": _load_text,
}


class _OptionalFormat(NamedTuple):
    extensions: tuple[str, ...]
    loader: Callable[[bytes], str]
    modules: tuple[str, ...]  # import names that must all be present for the loader to work
    extra: str  # the arca-ingest extra that provides them


_OPTIONAL_FORMATS: tuple[_OptionalFormat, ...] = (
    _OptionalFormat((".pdf",), _load_pdf, ("pypdf",), "pdf"),
    _OptionalFormat((".docx",), _load_docx, ("mammoth", "bs4", "markdownify"), "docx"),
    _OptionalFormat((".html", ".htm"), _load_html, ("bs4", "markdownify"), "html"),
    _OptionalFormat((".epub",), _load_epub, ("ebooklib", "bs4", "markdownify"), "epub"),
    _OptionalFormat((".fb2",), _load_fb2, ("defusedxml",), "fb2"),
)

# ext -> the extra that provides its loader, for every optional format whether installed
# or not, so an uninstalled format can name the right extra to install.
_EXTRA_FOR_EXT: dict[str, str] = {ext: fmt.extra for fmt in _OPTIONAL_FORMATS for ext in fmt.extensions}


def _module_available(module: str) -> bool:
    try:
        return importlib.util.find_spec(module) is not None
    except ImportError:
        return False


# Register each optional loader only when its parser is actually importable. The heavy
# import still happens lazily inside the loader; find_spec just locates it, no execution.
for _fmt in _OPTIONAL_FORMATS:
    if all(_module_available(module) for module in _fmt.modules):
        for _ext in _fmt.extensions:
            _LOADERS[_ext] = _fmt.loader


def supported_extensions() -> frozenset[str]:
    """Return the file extensions that have a registered, installed loader."""
    return frozenset(_LOADERS)


def load(data: bytes | str, *, name: str) -> str:
    """Decode/parse a source into plain text.

    Args:
        data: Raw bytes to decode, or already-decoded text (returned unchanged).
        name: Source name (filename); its extension selects the loader.

    Raises:
        UnsupportedFormat: when *data* is bytes and the extension has no installed loader.
            Known formats whose optional extra is missing name that extra in the message.
    """
    if isinstance(data, str):
        return data

    ext = PurePosixPath(name).suffix.lower()
    loader = _LOADERS.get(ext)
    if loader is None:
        extra = _EXTRA_FOR_EXT.get(ext)
        if extra is not None:
            raise UnsupportedFormat(
                f"{ext!r} support needs the optional {extra!r} extra: "
                f"pip install 'arca-ingest[{extra}]' (source {name!r})"
            )
        raise UnsupportedFormat(f"No loader for {ext!r} (source {name!r})")
    return loader(data)
