"""Unit tests for the source loaders."""

import pytest

from arca_ingest.loaders import UnsupportedFormat, load, supported_extensions


def test_bytes_are_decoded_as_utf8():
    assert load("héllo".encode("utf-8"), name="note.txt") == "héllo"


def test_str_input_is_returned_unchanged():
    assert load("already text", name="whatever.md") == "already text"


def test_markdown_extension_is_supported():
    assert load(b"# Title", name="README.md") == "# Title"


def test_unsupported_extension_raises():
    with pytest.raises(UnsupportedFormat):
        load(b"%PDF-1.7", name="paper.pdf")


def test_supported_extensions_includes_text_formats():
    exts = supported_extensions()
    assert {".txt", ".md", ".markdown"} <= exts
