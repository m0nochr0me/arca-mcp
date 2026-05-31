"""
Map memory rows into a JSON Canvas document (https://jsoncanvas.org/spec/1.0/).

The canvas is scoped to a single bucket. Edges whose target lives in another bucket
are rendered against a compact "external" stub node carrying the target's bucket, so
the UI can offer navigation into that bucket. Edges to targets that no longer exist
anywhere in the namespace get a stub with ``target_bucket = None``.

Layout here is a deterministic grid; it is only a seed. The interactive client may run
its own force-directed relaxation on top, and the grid keeps the document usable when
opened in a plain JSON Canvas renderer.
"""

import math
from uuid import UUID

NODE_W = 260
NODE_H = 120
STUB_H = 64
GAP_X = 80
GAP_Y = 60

# JSON Canvas preset colour for external stub nodes (orange).
_EXTERNAL_COLOR = "2"

__all__ = ("build_bucket_canvas",)


def _id_str(value: object) -> str:
    """Normalise a LanceDB ``memory_id`` (UUID or 16 raw bytes) to its string form."""
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, bytes):
        return str(UUID(bytes=value))
    return str(value)


def build_bucket_canvas(rows: list[dict], id_bucket: dict[str, str], bucket: str) -> dict:
    """Build a JSON Canvas dict for *bucket* from its memory *rows*.

    *rows* are the memories belonging to *bucket* (each with ``memory_id``, ``content``,
    ``connected_nodes``, ``relationship_types``, ``created_at``). *id_bucket* maps every
    memory id in the namespace to its bucket, used to resolve cross-bucket edge targets.
    """

    mems: list[dict] = []
    in_bucket: set[str] = set()
    for r in rows:
        mid = _id_str(r["memory_id"])
        in_bucket.add(mid)
        mems.append(
            {
                "id": mid,
                "content": r.get("content") or "",
                "connected": list(r.get("connected_nodes") or []),
                "rels": list(r.get("relationship_types") or []),
                "created_at": r.get("created_at"),
            }
        )

    nodes: list[dict] = []
    edges: list[dict] = []

    # Memory nodes laid out in a square-ish grid.
    cols = max(1, math.ceil(math.sqrt(len(mems)))) if mems else 1
    for i, m in enumerate(mems):
        nodes.append(
            {
                "id": m["id"],
                "type": "text",
                "text": m["content"],
                "x": (i % cols) * (NODE_W + GAP_X),
                "y": (i // cols) * (NODE_H + GAP_Y),
                "width": NODE_W,
                "height": NODE_H,
                "arca": {"kind": "memory", "bucket": bucket, "created_at": m["created_at"]},
            }
        )

    # External stub nodes sit in a row below the grid; one per distinct target.
    grid_rows = math.ceil(len(mems) / cols) if mems else 0
    stub_y = grid_rows * (NODE_H + GAP_Y) + GAP_Y
    stubs: dict[str, str] = {}  # target_id -> stub node id

    for m in mems:
        for target, rel in zip(m["connected"], m["rels"], strict=True):
            external = target not in in_bucket
            if external:
                if target not in stubs:
                    stub_id = f"ext:{target}"
                    stubs[target] = stub_id
                    target_bucket = id_bucket.get(target)
                    label = f"↗ {target_bucket}" if target_bucket else "↗ (missing)"
                    nodes.append(
                        {
                            "id": stub_id,
                            "type": "text",
                            "text": label,
                            "x": (len(stubs) - 1) * (NODE_W + GAP_X),
                            "y": stub_y,
                            "width": NODE_W,
                            "height": STUB_H,
                            "color": _EXTERNAL_COLOR,
                            "arca": {
                                "kind": "external",
                                "target_id": target,
                                "target_bucket": target_bucket,
                            },
                        }
                    )
                to_node = stubs[target]
            else:
                to_node = target

            edges.append(
                {
                    "id": f"{m['id']}->{target}#{rel}",
                    "fromNode": m["id"],
                    "toNode": to_node,
                    "toEnd": "arrow",
                    "label": rel,
                    "arca": {"relationship_type": rel, "external": external},
                }
            )

    return {"nodes": nodes, "edges": edges}
