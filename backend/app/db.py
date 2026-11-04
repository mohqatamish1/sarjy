from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import get_settings
from app.providers.errors import ProviderError


class Base(DeclarativeBase):
    pass


engine = create_engine(
    get_settings().db_url, pool_pre_ping=True, pool_size=5, connect_args={"connect_timeout": 5}
)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


def get_db():
    """Function-scoped dependency: finish the transaction before sending the response."""
    with SessionLocal() as session:
        try:
            yield session
            session.commit()
        except ProviderError:
            # Workflow edits must survive a weather outage, without stale recommendations.
            session.commit()
            raise
        except Exception:
            session.rollback()
            raise
