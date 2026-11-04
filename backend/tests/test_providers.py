from datetime import UTC, datetime, timedelta

import httpx
import pytest

from app.config import Settings
from app.providers.errors import ProviderError
from app.providers.groq import GroqProvider
from app.providers.weather import WeatherProvider


def groq(handler, key="test-key"):
    return GroqProvider(
        Settings(groq_api_key=key), httpx.Client(transport=httpx.MockTransport(handler))
    )


def test_groq_completion_http_contract():
    def handler(request):
        import json

        assert request.url.path == "/openai/v1/chat/completions"
        assert request.headers["authorization"] == "Bearer test-key"
        payload = json.loads(request.content)
        assert payload["model"] == "openai/gpt-oss-20b"
        assert payload["tools"][0]["function"]["name"] == "weather"
        return httpx.Response(200, json={"choices": [{"message": {"content": "Hello"}}]})

    assert groq(handler).complete([{"role": "user", "content": "Hi"}])["content"] == "Hello"


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "credentials_invalid"),
        (403, "credentials_invalid"),
        (404, "model_unavailable"),
        (429, "rate_limited"),
        (500, "provider_unavailable"),
    ],
)
def test_groq_failure_modes(status, code):
    with pytest.raises(ProviderError) as exc:
        groq(lambda request: httpx.Response(status)).complete([])
    assert exc.value.code == code


def test_missing_key_never_calls_network():
    def handler(request):
        pytest.fail("Network must not be called without a key")

    with pytest.raises(ProviderError, match="Groq API key"):
        groq(handler, key="").complete([])


@pytest.mark.parametrize(
    "payload", [{}, {"choices": []}, {"choices": [{"message": {"content": ""}}]}]
)
def test_malformed_groq_completion(payload):
    with pytest.raises(ProviderError):
        groq(lambda request: httpx.Response(200, json=payload)).complete([])


def test_groq_timeout():
    def handler(request):
        raise httpx.ReadTimeout("timeout")

    with pytest.raises(ProviderError):
        groq(handler).complete([])


def test_whisper_multipart_contract():
    def handler(request):
        assert request.url.path == "/openai/v1/audio/transcriptions"
        assert request.headers["content-type"].startswith("multipart/form-data")
        assert b"whisper-large-v3-turbo" in request.content
        assert b"test voice bytes" in request.content
        return httpx.Response(200, json={"text": " مرحبا "})

    assert groq(handler).transcribe(b"test voice bytes", "voice.webm", "audio/webm") == "مرحبا"


def test_empty_whisper_result():
    with pytest.raises(ProviderError) as exc:
        groq(lambda request: httpx.Response(200, json={"text": " "})).transcribe(
            b"x", "voice.webm", "audio/webm"
        )
    assert exc.value.code == "no_speech"


def weather(handler):
    return WeatherProvider(Settings(), httpx.Client(transport=httpx.MockTransport(handler)))


def test_open_meteo_geocoding_and_forecast_contract():
    day = datetime.now(UTC).date() + timedelta(days=1)

    def handler(request):
        if "geocoding" in request.url.host:
            assert request.url.params["name"] == "Riyadh"
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "name": "Riyadh",
                            "country": "Saudi Arabia",
                            "timezone": "Asia/Riyadh",
                            "latitude": 24.7,
                            "longitude": 46.7,
                        }
                    ]
                },
            )
        assert request.url.params["start_date"] == day.isoformat()
        assert request.url.params["timezone"] == "Asia/Riyadh"
        return httpx.Response(
            200,
            json={
                "daily": {
                    "time": [day.isoformat()],
                    "temperature_2m_max": [31],
                    "temperature_2m_min": [21],
                    "precipitation_probability_max": [10],
                    "wind_speed_10m_max": [15],
                    "weather_code": [0],
                }
            },
        )

    result = weather(handler).forecast("Riyadh", day)
    assert result["high_c"] == 31 and result["source"] == "Open-Meteo"
    assert result["country"] == "Saudi Arabia"


def test_city_not_found():
    with pytest.raises(ProviderError) as exc:
        weather(lambda request: httpx.Response(200, json={})).forecast(
            "Unknown", datetime.now(UTC).date()
        )
    assert exc.value.code == "city_not_found"


def test_forecast_outside_range_never_fabricates():
    def handler(request):
        assert "geocoding" in request.url.host
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "name": "Riyadh",
                        "latitude": 24.7,
                        "longitude": 46.7,
                        "timezone": "Asia/Riyadh",
                    }
                ]
            },
        )

    with pytest.raises(ProviderError) as exc:
        weather(handler).forecast("Riyadh", datetime.now(UTC).date() + timedelta(days=60))
    assert exc.value.code == "forecast_range"


@pytest.mark.parametrize("status", [429, 500])
def test_weather_http_errors(status):
    with pytest.raises(ProviderError) as exc:
        weather(lambda request: httpx.Response(status)).forecast("Riyadh", datetime.now(UTC).date())
    assert exc.value.code == "weather_unavailable"


def test_weather_invalid_daily_data():
    def handler(request):
        if "geocoding" in request.url.host:
            return httpx.Response(
                200, json={"results": [{"name": "Riyadh", "latitude": 24.7, "longitude": 46.7}]}
            )
        return httpx.Response(200, json={"daily": {"time": []}})

    with pytest.raises(ProviderError) as exc:
        weather(handler).forecast("Riyadh", datetime.now(UTC).date())
    assert exc.value.code == "weather_invalid"


@pytest.mark.parametrize(
    "metadata",
    [
        {"no_speech_prob": 0.95},
        {"avg_logprob": -1.5},
        {"compression_ratio": 3.5},
    ],
)
def test_unclear_whisper_output_is_not_accepted(metadata):
    with pytest.raises(ProviderError) as exc:
        groq(
            lambda request: httpx.Response(
                200,
                json={
                    "text": "Thank you, thank you",
                    "segments": [{"text": "Thank you, thank you", **metadata}],
                },
            )
        ).transcribe(b"audio", "voice.wav", "audio/wav")
    assert exc.value.code == "unclear_speech"


def test_real_thank_you_is_not_blacklisted_and_arabic_hint_is_forwarded():
    def handler(request):
        assert (
            b"verbose_json" in request.content and b'name="language"\r\n\r\nar' in request.content
        )
        return httpx.Response(
            200,
            json={
                "text": "شكرا لك",
                "segments": [
                    {"no_speech_prob": 0.01, "avg_logprob": -0.2, "compression_ratio": 1.2}
                ],
            },
        )

    assert groq(handler).transcribe(b"audio", "voice.wav", "audio/wav", "ar") == "شكرا لك"


@pytest.mark.parametrize(
    "text,model,voice",
    [
        ("Hello there", "canopylabs/orpheus-v1-english", "troy"),
        ("مرحبا بك", "canopylabs/orpheus-arabic-saudi", "fahad"),
    ],
)
def test_speech_selects_language_model(text, model, voice):
    import io
    import json
    import wave

    audio = io.BytesIO()
    with wave.open(audio, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"\0" * 48)
    streamed = bytearray(audio.getvalue())
    streamed[40:44] = (0xFFFFFFFF).to_bytes(4, "little")

    def handler(request):
        payload = json.loads(request.content)
        assert request.url.path == "/openai/v1/audio/speech"
        assert payload == {"model": model, "voice": voice, "input": text, "response_format": "wav"}
        return httpx.Response(200, content=bytes(streamed))

    result = groq(handler).speech(text)
    with wave.open(io.BytesIO(result)) as wav:
        assert wav.getnframes() == 24


def test_speech_terms_error_is_actionable():
    with pytest.raises(ProviderError) as exc:
        groq(
            lambda request: httpx.Response(400, json={"error": {"code": "model_terms_required"}})
        ).speech("Hello")
    assert exc.value.code == "speech_terms_required"


def test_retries_transient_status_then_recovers(monkeypatch):
    from app.providers import http

    delays = []
    monkeypatch.setattr(http.time, "sleep", delays.append)
    statuses = iter([503, 429, 200])

    def handler(request):
        status = next(statuses)
        return httpx.Response(
            status,
            headers={"retry-after": "1"},
            json={"choices": [{"message": {"content": "Recovered"}}]},
        )

    assert groq(handler).complete([])["content"] == "Recovered"
    assert delays == [1, 1]


def test_long_retry_after_and_auth_failures_are_not_retried(monkeypatch):
    from app.providers import http

    monkeypatch.setattr(http.time, "sleep", lambda _: pytest.fail("Must not sleep"))
    for status in (401, 403, 400, 429):
        calls = []

        def handler(request, calls=calls, status=status):
            calls.append(request)
            return httpx.Response(status, headers={"retry-after": "3600"}, json={"error": {}})

        with pytest.raises(ProviderError):
            groq(handler).complete([])
        assert len(calls) == 1


def test_ambiguous_read_timeout_is_not_replayed():
    calls = []

    def handler(request):
        calls.append(request)
        raise httpx.ReadTimeout("already sent")

    with pytest.raises(ProviderError):
        groq(handler).complete([])
    assert len(calls) == 1


def test_memory_extractor_validates_json_and_has_no_tools():
    import json

    def handler(request):
        payload = json.loads(request.content)
        assert "tools" not in payload and payload["response_format"] == {"type": "json_object"}
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": '{"facts":[{"category":"name","text":"My name is Sam"}]}'
                        }
                    }
                ]
            },
        )

    assert groq(handler).extract_memories("My name is Sam")[0]["text"] == "My name is Sam"
    with pytest.raises(ProviderError):
        groq(lambda request: httpx.Response(200, json={})).extract_memories("My name is Sam")


def test_connection_failure_is_retried_before_request_acceptance(monkeypatch):
    from app.providers import http

    monkeypatch.setattr(http.time, "sleep", lambda _: None)
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) < 3:
            raise httpx.ConnectError("connection refused")
        return httpx.Response(200, json={"choices": [{"message": {"content": "Recovered"}}]})

    assert groq(handler).complete([])["content"] == "Recovered"
    assert len(calls) == 3


def test_retry_after_http_date_and_nonfinite_value():
    from email.utils import format_datetime

    from app.providers.http import retry_delay

    delay = retry_delay(format_datetime(datetime.now(UTC) + timedelta(seconds=5)), 0)
    assert 3 <= delay <= 5
    assert retry_delay("Infinity", 0) == float("inf")


@pytest.mark.parametrize("body", [[], {"error": "invalid"}])
def test_malformed_provider_error_is_bounded(body):
    with pytest.raises(ProviderError) as exc:
        groq(lambda request: httpx.Response(400, json=body)).complete([])
    assert exc.value.code == "provider_unavailable"


@pytest.mark.parametrize("scheme", ["postgres", "postgresql", "postgresql+psycopg"])
def test_managed_database_url_uses_installed_driver(scheme):
    result = Settings(database_url=f"{scheme}://user:password@private-db:5432/sarjy").db_url
    assert result.drivername == "postgresql+psycopg"
    assert result.host == "private-db" and result.database == "sarjy"
