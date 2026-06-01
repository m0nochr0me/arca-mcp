"""Unit tests for the source loaders.

Text-format tests always run. Each optional-format test is gated with ``importorskip`` so
the suite stays green whether or not that parser's extra is installed.
"""

import importlib.util
import io

import pytest

from arca_ingest.loaders import UnsupportedFormat, load, supported_extensions


def test_bytes_are_decoded_as_utf8():
    assert load("héllo".encode("utf-8"), name="note.txt") == "héllo"


def test_str_input_is_returned_unchanged():
    assert load("already text", name="whatever.md") == "already text"


def test_markdown_extension_is_supported():
    assert load(b"# Title", name="README.md") == "# Title"


def test_unknown_extension_raises():
    with pytest.raises(UnsupportedFormat):
        load(b"binary blob", name="archive.xyz")


def test_supported_extensions_includes_text_formats():
    exts = supported_extensions()
    assert {".txt", ".md", ".markdown"} <= exts


def test_uninstalled_optional_format_names_its_extra():
    # When pypdf isn't installed, .pdf isn't supported and the error names the extra.
    # Skip if it happens to be installed (then .pdf is a real, supported format).
    if importlib.util.find_spec("pypdf") is not None:
        pytest.skip("pypdf installed; the install-hint branch isn't exercised")
    assert ".pdf" not in supported_extensions()
    with pytest.raises(UnsupportedFormat, match=r"arca-ingest\[pdf\]"):
        load(b"%PDF-1.7", name="paper.pdf")


def test_html_loader_extracts_text_and_drops_scripts():
    pytest.importorskip("bs4")
    assert {".html", ".htm"} <= supported_extensions()
    markup = b"<html><body><h1>Hello</h1><p>World</p><script>bad()</script></body></html>"
    text = load(markup, name="page.html")
    assert "Hello" in text and "World" in text
    assert "bad()" not in text


def test_fb2_loader_extracts_body_and_skips_metadata():
    pytest.importorskip("defusedxml")
    assert ".fb2" in supported_extensions()
    fb2 = (
        b'<?xml version="1.0" encoding="utf-8"?>'
        b'<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">'
        b"<description><title-info><book-title>Meta Title</book-title></title-info></description>"
        b"<body><section><title><p>Chapter</p></title>"
        b"<p>First <emphasis>para</emphasis>.</p><p>Second para.</p></section></body>"
        b'<binary id="i" content-type="image/png">QUJD</binary>'
        b"</FictionBook>"
    )
    text = load(fb2, name="book.fb2")
    assert "First para." in text
    assert "Second para." in text
    assert "Chapter" in text
    assert "Meta Title" not in text  # <description> is skipped
    assert "QUJD" not in text  # <binary> is skipped


def test_docx_loader_extracts_paragraphs():
    docx = pytest.importorskip("docx")
    assert ".docx" in supported_extensions()
    document = docx.Document()
    document.add_paragraph("First paragraph")
    document.add_paragraph("Second paragraph")
    buffer = io.BytesIO()
    document.save(buffer)
    text = load(buffer.getvalue(), name="report.docx")
    assert "First paragraph" in text
    assert "Second paragraph" in text


def test_epub_loader_extracts_text_in_spine_order():
    pytest.importorskip("bs4")
    epub = pytest.importorskip("ebooklib.epub", reason="ebooklib not installed")
    assert ".epub" in supported_extensions()

    book = epub.EpubBook()
    book.set_identifier("id1")
    book.set_title("Title")
    book.set_language("en")
    chapter = epub.EpubHtml(title="C1", file_name="c1.xhtml")
    chapter.content = "<html><body><h1>Heading</h1><p>Epub body text.</p></body></html>"
    book.add_item(chapter)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = [chapter]
    buffer = io.BytesIO()
    epub.write_epub(buffer, book)

    text = load(buffer.getvalue(), name="book.epub")
    assert "Heading" in text
    assert "Epub body text." in text


def _make_pdf(text: str) -> bytes:
    """Build a minimal single-page PDF with one line of text and a correct xref table."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    ]
    stream = b"BT /F1 24 Tf 72 720 Td (" + text.encode("latin-1") + b") Tj ET"
    objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += str(number).encode() + b" 0 obj\n" + body + b"\nendobj\n"
    xref_pos = len(out)
    size = len(objects) + 1
    out += b"xref\n0 " + str(size).encode() + b"\n0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size " + str(size).encode() + b" /Root 1 0 R >>\n"
    out += b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF"
    return bytes(out)


def test_pdf_loader_extracts_text():
    pytest.importorskip("pypdf")
    assert ".pdf" in supported_extensions()
    text = load(_make_pdf("Hello PDF"), name="paper.pdf")
    assert "Hello PDF" in text
