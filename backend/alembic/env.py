from sqlalchemy import create_engine, pool, text

from alembic import context
from app import models  # noqa: F401
from app.config import get_settings
from app.db import Base

config = context.config
target_metadata = Base.metadata


def run_migrations():
    if context.is_offline_mode():
        context.configure(
            url=get_settings().db_url, target_metadata=target_metadata, literal_binds=True
        )
        with context.begin_transaction():
            context.run_migrations()
        return
    connectable = create_engine(
        get_settings().db_url, poolclass=pool.NullPool, connect_args={"connect_timeout": 5}
    )
    with connectable.connect() as connection:
        # One migrator per database. Transaction-level lock is released even on failure.
        with connection.begin():
            connection.execute(text("SELECT pg_advisory_xact_lock(734291001)"))
            context.configure(connection=connection, target_metadata=target_metadata)
            context.run_migrations()


run_migrations()
