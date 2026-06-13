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

- **Formats:** `.txt` / `.md` out of the box. PDF, DOCX, HTML, EPUB, and FB2 each ship as
  an optional extra — `arca-ingest[pdf]`, `[docx]`, `[html]`, `[epub]`, `[fb2]`, or
  `[all]` — so a minimal install never pulls a heavy parser. A loader registers itself
  only when its parser is importable; an unsupported source raises `UnsupportedFormat`
  naming the extra to install.
- **Fidelity:** structured formats (DOCX via `mammoth`, HTML and EPUB via `markdownify`)
  are rendered as Markdown — headings, lists, tables, and link targets survive into the
  chunks instead of being flattened to plain text.
- **Chunking:** [`semchunk`](https://pypi.org/project/semchunk/) with a dependency-free
  word-count token counter by default (swap in a real tokenizer for token-accurate
  sizing).

```python
# light install: just text formats
pip install arca-ingest
# with every format loader
pip install 'arca-ingest[all]'
```

See [`doc/ingestion-plan.md`](../../doc/ingestion-plan.md) for the full design.
