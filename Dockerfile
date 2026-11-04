# Production: one stateless app; PostgreSQL runs separately (managed or Compose).
FROM node:24-bookworm-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM python:3.12-slim-bookworm AS runtime
COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /usr/local/bin/uv
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1 \
    PATH="/app/.venv/bin:$PATH" NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 \
    BACKEND_URL=http://127.0.0.1:8000 COOKIE_SECURE=true
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY backend/app ./app
COPY backend/alembic ./alembic
COPY backend/alembic.ini ./
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=web /web/.next/standalone ./web
COPY --from=web /web/.next/static ./web/.next/static
COPY --from=web /web/public ./web/public
COPY scripts/start-production.sh ./start-production.sh
RUN useradd --uid 10001 --create-home sarjy && chown -R sarjy:sarjy /app
USER sarjy
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["/app/start-production.sh"]
