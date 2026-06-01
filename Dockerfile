# -- Stage 1: Base

# Base + uv
FROM python:3.14-slim-bookworm AS base
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Env
ENV TZ=UTC
ENV LANG=en_US.UTF-8
ENV UV_CACHE_DIR=/tmp/uv-cache
ENV PYTHON_JIT=1
ENV PYTHONUNBUFFERED=1
ENV UV_COMPILE_BYTECODE=1
ENV UV_PROJECT_ENVIRONMENT=/usr/local

# Install
WORKDIR /app

RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

RUN --mount=type=cache,target=/tmp/uv-cache \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=packages,target=packages \
    uv sync --locked --no-install-project --no-dev

COPY . .

RUN --mount=type=cache,target=/tmp/uv-cache \
    uv pip install --system -e .

RUN chmod +x run.sh

# -- Stage 2: Run
FROM base AS final
ARG ARCA_INSTALL_EXTRAS=""

# Install extras. --inexact keeps the root project (installed editable in the base stage)
# instead of pruning it, since --no-install-project would otherwise treat it as extraneous.
RUN --mount=type=cache,target=/tmp/uv-cache \
    if [ -n "$ARCA_INSTALL_EXTRAS" ]; then \
      uv sync --locked --no-install-project --no-dev --inexact --extra "$ARCA_INSTALL_EXTRAS"; fi

# Run
CMD [ "/app/run.sh" ]
