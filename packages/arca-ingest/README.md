# arca-ingest

Optional document loading and chunking add-on for [Arca MCP](../../README.md).

A small, transport-agnostic library: it turns a source document into ordered chunks and
nothing more — no embedding, no storage, no server imports. The Arca server consumes it
in-process to expose `POST /v1/ingest` and the `memory/ingest` MCP tool, but the library
is usable on its own.

```python
import arca_ingest

chunks = arca_ingest.ingest(open("notes.md", "rb").read(), name="notes.md")
for c in chunks:
    print(c.index, c.content)
```

## Scope

- **Formats:** `.txt`, `.md` today. PDF / DOCX / HTML register as optional extras later.
- **Chunking:** [`semchunk`](https://pypi.org/project/semchunk/) with a dependency-free
  word-count token counter by default (swap in a real tokenizer for token-accurate
  sizing).

See [`doc/ingestion-plan.md`](../../doc/ingestion-plan.md) for the full design.
