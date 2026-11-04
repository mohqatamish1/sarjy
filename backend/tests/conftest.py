"""Integration tests run against PostgreSQL in a disposable, random schema."""

from uuid import uuid4

import pytest
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from alembic import command
from app.config import get_settings
from app.db import Base, get_db
from app.main import app
from app.providers.errors import ProviderError


@pytest.fixture(scope="session")
def test_engine():
    settings = get_settings()
    original = settings.database_url
    admin = create_engine(settings.db_url)
    schema = "test_sarjy_" + uuid4().hex
    with admin.begin() as connection:
        connection.execute(text(f'CREATE SCHEMA "{schema}"'))
    url = admin.url.update_query_dict({"options": f"-csearch_path={schema}"})
    settings.database_url = url.render_as_string(hide_password=False)
    isolated = create_engine(url, pool_pre_ping=True)
    try:
        # Exercise the real migration instead of create_all; tables must work on PostgreSQL.
        command.upgrade(Config("alembic.ini"), "head")
        command.upgrade(Config("alembic.ini"), "head")
        yield isolated
    finally:
        isolated.dispose()
        settings.database_url = original
        with admin.begin() as connection:
            connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        admin.dispose()


@pytest.fixture
def client(test_engine):
    with test_engine.begin() as connection:
        tables = ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
        connection.execute(text(f"TRUNCATE {tables} CASCADE"))
    factory = sessionmaker(test_engine, expire_on_commit=False)

    def isolated_db():
        with factory() as db:
            try:
                yield db
                db.commit()
            except ProviderError:
                db.commit()
                raise
            except Exception:
                db.rollback()
                raise

    app.dependency_overrides[get_db] = isolated_db
    with TestClient(app) as browser:
        browser.get("/api/session")
        yield browser
    app.dependency_overrides.clear()
