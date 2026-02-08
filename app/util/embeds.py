from typing import Literal

from google.genai import types

from app.core.ai import ai_client
from app.core.cache import cache, make_cache_key
from app.core.config import settings


async def get_embedding(
    text: str,
    mode: Literal[
        "retrieval",
        "storage",
    ] = "retrieval",
) -> list[float]:
    """Get the embedding vector for the given text using the AI client."""

    cache_key = f"embedding_{make_cache_key(mode, text)}"
    if cached_embedding := await cache.get(cache_key):
        return cached_embedding

    response = await ai_client.aio.models.embed_content(
        model=settings.EMBEDDING_MODEL,
        contents=[text],
        config=types.EmbedContentConfig(
            task_type="RETRIEVAL_QUERY" if mode == "retrieval" else "RETRIEVAL_DOCUMENT",
            output_dimensionality=settings.EMBEDDING_DIMENSION,
        ),
    )

    if not response.embeddings or len(response.embeddings) == 0:
        raise ValueError("No embeddings returned from the AI client.")
    if not response.embeddings[0].values:
        raise ValueError("No embedding values returned from the AI client.")

    await cache.set(cache_key, response.embeddings[0].values, ttl=settings.CACHE_TTL_LONG)

    return response.embeddings[0].values
