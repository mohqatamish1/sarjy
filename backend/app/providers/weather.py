from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import httpx

from app.config import Settings, get_settings
from app.providers.errors import ProviderError
from app.providers.http import request_with_retry


def weather_label(code: int) -> str:
    if code == 0:
        return "Clear sky"
    if code in (1, 2, 3):
        return "Partly cloudy" if code != 3 else "Overcast"
    if code in (45, 48):
        return "Fog"
    if code in (71, 73, 75, 77, 85, 86):
        return "Snow"
    if code in (95, 96, 99):
        return "Thunderstorms"
    return "Rain or showers"


class WeatherProvider:
    def __init__(self, settings: Settings, client: httpx.Client | None = None):
        self.settings = settings
        self.client = client or httpx.Client(timeout=15)

    def _get(self, url, params):
        if self.settings.open_meteo_api_key:
            params["apikey"] = self.settings.open_meteo_api_key
        try:
            response = request_with_retry(self.client, "GET", url, params=params, budget=10.0)
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict) or result.get("error"):
                raise ValueError("invalid weather response")
            return result
        except (httpx.HTTPError, ValueError) as exc:
            raise ProviderError(
                "Open-Meteo is unavailable. Your details are saved; retry when the weather service is back.",
                "weather_unavailable",
            ) from exc

    def forecast(self, city: str, day: date) -> dict:
        locations = self._get(
            self.settings.open_meteo_geocoding_url,
            {"name": city, "count": 1, "language": "en", "format": "json"},
        )
        if not locations.get("results"):
            raise ProviderError(
                "That city could not be found. Try the city name with its country.",
                "city_not_found",
                422,
            )
        try:
            location = locations["results"][0]
            timezone = location.get("timezone", "UTC")
            today = datetime.now(ZoneInfo(timezone)).date()
            if not today <= day <= today + timedelta(days=15):
                raise ProviderError(
                    "Choose a date from today through the next 15 days; a reliable forecast is not available outside this window.",
                    "forecast_range",
                    422,
                )
            result = self._get(
                self.settings.open_meteo_forecast_url,
                {
                    "latitude": location["latitude"],
                    "longitude": location["longitude"],
                    "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
                    "start_date": day.isoformat(),
                    "end_date": day.isoformat(),
                    "timezone": timezone,
                },
            )
            daily = result["daily"]
            if daily["time"][0] != day.isoformat():
                raise ValueError("wrong forecast date")
            values = [
                daily[k][0]
                for k in (
                    "temperature_2m_max",
                    "temperature_2m_min",
                    "precipitation_probability_max",
                    "wind_speed_10m_max",
                    "weather_code",
                )
            ]
            if any(v is None or not isinstance(v, (float, int)) for v in values):
                raise ValueError("missing weather observations")
            high, low, rain, wind, code = values
            return {
                "city": location["name"],
                "country": location.get("country", ""),
                "latitude": location["latitude"],
                "longitude": location["longitude"],
                "date": day.isoformat(),
                "timezone": timezone,
                "high_c": high,
                "low_c": low,
                "rain_percent": rain,
                "wind_kmh": wind,
                "code": code,
                "summary": weather_label(code),
                "source": "Open-Meteo",
                "source_url": "https://open-meteo.com/",
                "fetched_at": datetime.now(UTC).isoformat(),
            }
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ProviderError(
                "Open-Meteo returned incomplete forecast data. Please retry.", "weather_invalid"
            ) from exc


def get_weather():
    provider = WeatherProvider(get_settings())
    try:
        yield provider
    finally:
        provider.client.close()
