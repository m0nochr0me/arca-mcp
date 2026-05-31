"""
Response models for the JSON Canvas (https://jsoncanvas.org/spec/1.0/) view of memory.

Only the subset of the spec we emit is modelled. Nodes and edges carry an extra
``arca`` object holding our domain metadata; this is ignored by spec-compliant
renderers (e.g. Obsidian) but consumed by the in-app canvas.
"""

from datetime import datetime

from pydantic import BaseModel


class CanvasNodeMeta(BaseModel):
    """Arca extension metadata attached to a canvas node."""

    kind: str  # "memory" | "external"
    bucket: str | None = None
    created_at: datetime | None = None
    # Only set on external (cross-bucket) stub nodes:
    target_id: str | None = None
    target_bucket: str | None = None


class CanvasEdgeMeta(BaseModel):
    """Arca extension metadata attached to a canvas edge."""

    relationship_type: str
    external: bool = False


class CanvasNode(BaseModel):
    id: str
    type: str = "text"
    text: str
    x: int
    y: int
    width: int
    height: int
    color: str | None = None
    arca: CanvasNodeMeta


class CanvasEdge(BaseModel):
    id: str
    fromNode: str  # noqa: N815 - JSON Canvas spec field name
    toNode: str  # noqa: N815 - JSON Canvas spec field name
    toEnd: str = "arrow"  # noqa: N815 - JSON Canvas spec field name
    label: str | None = None
    arca: CanvasEdgeMeta


class CanvasResponse(BaseModel):
    """A JSON Canvas document scoped to a single bucket."""

    nodes: list[CanvasNode]
    edges: list[CanvasEdge]
