from typing import Literal, overload

from google.genai import types

from app.core.ai import ai_client
from app.core.cache import cache, make_cache_key
from app.core.config import settings

_MAX_BATCH_SIZE = 100


@overload
async def get_embedding(
    text: str,
    mode: Literal["retrieval", "storage"] = "retrieval",
) -> list[float]: ...


@overload
async def get_embedding(
    text: list[str],
    mode: Literal["retrieval", "storage"] = "retrieval",
) -> list[list[float]]: ...


async def get_embedding(
    text: str | list[str],
    mode: Literal["retrieval", "storage"] = "retrieval",
) -> list[float] | list[list[float]]:
    """Get embedding vector(s) for the given text(s).

    Accepts a single string or a list of up to 100 strings.
    Returns a single vector for a string input, or a list of vectors for list input.
    """

    if isinstance(text, str):
        return await _get_single_embedding(text, mode)

    if len(text) > _MAX_BATCH_SIZE:
        raise ValueError(f"Batch size {len(text)} exceeds maximum of {_MAX_BATCH_SIZE}")
    if not text:
        return []

    # Check cache for each item; track which need API calls
    results: list[list[float] | None] = [None] * len(text)
    uncached_indices: list[int] = []
    uncached_texts: list[str] = []

    for i, t in enumerate(text):
        cache_key = f"embedding_{make_cache_key(mode, t)}"
        if cached := await cache.get(cache_key):
            results[i] = cached
        else:
            uncached_indices.append(i)
            uncached_texts.append(t)

    if uncached_texts:
        response = await ai_client.aio.models.embed_content(
            model=settings.EMBEDDING_MODEL,
            contents=uncached_texts,
            config=types.EmbedContentConfig(
                task_type="RETRIEVAL_QUERY" if mode == "retrieval" else "RETRIEVAL_DOCUMENT",
                output_dimensionality=settings.EMBEDDING_DIMENSION,
            ),
        )

        if not response.embeddings or len(response.embeddings) != len(uncached_texts):
            raise ValueError("Unexpected number of embeddings returned from the AI client.")

        for idx, emb in zip(uncached_indices, response.embeddings, strict=True):
            if not emb.values:
                raise ValueError(f"No embedding values returned for item at index {idx}.")
            results[idx] = emb.values
            cache_key = f"embedding_{make_cache_key(mode, uncached_texts[uncached_indices.index(idx)])}"
            await cache.set(cache_key, emb.values, ttl=settings.CACHE_TTL_LONG)

    return results  # type: ignore[return-value]


async def _get_single_embedding(
    text: str,
    mode: Literal["retrieval", "storage"],
) -> list[float]:
    """Get the embedding vector for a single text string."""

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
