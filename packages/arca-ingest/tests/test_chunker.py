"""Unit tests for the chunker (pure, no network)."""

import arca_ingest
from arca_ingest.chunker import chunk_text

# 300 short sentences ~ 2100 whitespace words.
LONG_TEXT = ". ".join(f"sentence number {i} with some filler words here" for i in range(300)) + "."


def test_empty_and_whitespace_yield_no_chunks():
    assert chunk_text("") == []
    assert chunk_text("   \n\t  ") == []


def test_short_text_is_a_single_chunk():
    chunks = chunk_text("hello world", chunk_size=512)
    assert len(chunks) == 1
    assert chunks[0].index == 0
    assert chunks[0].content == "hello world"


def test_long_text_splits_into_ordered_chunks_within_size():
    chunk_size = 50
    chunks = chunk_text(LONG_TEXT, chunk_size=chunk_size, overlap=0)

    assert len(chunks) > 1
    # Indices are sequential starting at zero.
    assert [c.index for c in chunks] == list(range(len(chunks)))
    # Every chunk respects the size budget (word count, matching the default counter).
    assert all(len(c.content.split()) <= chunk_size for c in chunks)


def test_offsets_are_in_bounds_and_recoverable():
    chunks = chunk_text(LONG_TEXT, chunk_size=50, overlap=0)
    for c in chunks:
        assert c.start is not None and c.end is not None
        assert 0 <= c.start < c.end <= len(LONG_TEXT)
        # The chunk text appears at its reported span (semchunk may trim whitespace,
        # so check containment rather than exact slice equality).
        assert c.content.strip() in LONG_TEXT[c.start : c.end]


def test_custom_token_counter_is_used():
    # A character counter makes chunks much smaller for the same numeric size.
    by_words = chunk_text(LONG_TEXT, chunk_size=50, overlap=0)
    by_chars = chunk_text(LONG_TEXT, chunk_size=50, overlap=0, token_counter=len)
    assert len(by_chars) > len(by_words)


def test_ingest_loads_then_chunks():
    chunks = arca_ingest.ingest(LONG_TEXT.encode("utf-8"), name="doc.md", chunk_size=50, overlap=0)
    assert len(chunks) > 1
    assert chunks[0].index == 0
