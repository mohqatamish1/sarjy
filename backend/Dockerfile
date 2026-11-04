FROM python:3.12-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /usr/local/bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 PATH="/app/.venv/bin:$PATH"
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
RUN useradd --uid 10001 --create-home sarjy

FROM base AS test
RUN uv sync --frozen --no-install-project
COPY tests ./tests
CMD ["pytest", "-q"]

FROM base AS runtime
USER sarjy
EXPOSE 8000
# Migration failure stops startup. Advisory locking serializes concurrent migrators.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-server-header"]
