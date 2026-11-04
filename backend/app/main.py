from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api import router
from app.config import get_settings
from app.db import engine
from app.providers.errors import ProviderError, public_message

app = FastAPI(
    title="Sarjy API", version="0.1.0", docs_url="/api/docs", openapi_url="/api/openapi.json"
)
app.include_router(router)


@app.middleware("http")
async def request_boundary(request: Request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != get_settings().app_origin.rstrip("/"):
            return JSONResponse({"detail": "Origin is not allowed"}, status_code=403)
        length = request.headers.get("content-length")
        if length and (not length.isdigit() or int(length) > 11 * 1024 * 1024):
            return JSONResponse({"detail": "Request is too large"}, status_code=413)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.exception_handler(ProviderError)
async def provider_error(request: Request, exc: ProviderError):
    return JSONResponse(
        {"detail": public_message(exc.code), "code": exc.code}, status_code=exc.status
    )


@app.get("/api/health")
def health():
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except Exception:
        return JSONResponse({"status": "unhealthy", "database": "unavailable"}, status_code=503)
