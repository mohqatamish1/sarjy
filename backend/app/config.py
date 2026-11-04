from functools import lru_cache
from zoneinfo import ZoneInfo

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL
from sqlalchemy.engine import make_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str = ""
    db_host: str = "db"
    postgres_user: str = "sarjy"
    postgres_db: str = "sarjy"
    postgres_password: str = ""

    @property
    def db_url(self):
        if self.database_url:
            url = make_url(self.database_url)
            # Managed platforms commonly supply postgresql://; our installed driver is psycopg 3.
            return (
                url.set(drivername="postgresql+psycopg")
                if url.drivername in ("postgres", "postgresql")
                else url
            )
        return URL.create(
            "postgresql+psycopg",
            username=self.postgres_user,
            password=self.postgres_password,
            host=self.db_host,
            database=self.postgres_db,
        )

    app_origin: str = "http://localhost:3000"
    cookie_secure: bool = False
    app_timezone: str = "Asia/Riyadh"
    groq_api_key: str = ""
    groq_chat_model: str = "openai/gpt-oss-20b"
    groq_whisper_model: str = "whisper-large-v3-turbo"
    groq_tts_model: str = "canopylabs/orpheus-v1-english"
    groq_tts_voice: str = "troy"
    groq_tts_arabic_model: str = "canopylabs/orpheus-arabic-saudi"
    groq_tts_arabic_voice: str = "fahad"
    open_meteo_api_key: str = ""
    open_meteo_geocoding_url: str = "https://geocoding-api.open-meteo.com/v1/search"
    open_meteo_forecast_url: str = "https://api.open-meteo.com/v1/forecast"

    @field_validator("app_timezone")
    @classmethod
    def valid_zone(cls, value: str) -> str:
        ZoneInfo(value)
        return value


@lru_cache
def get_settings() -> Settings:
    return Settings()
