from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.config import get_settings
from app.main import app
from app.providers.errors import ProviderError
from app.providers.groq import get_groq
from app.providers.weather import get_weather


def conversation(client):
    response = client.post("/api/conversations")
    assert response.status_code == 201
    return response.json()["id"]


def send(client, cid, content, request_id=None):
    return client.post(
        f"/api/conversations/{cid}/messages",
        json={"content": content, "request_id": request_id or str(uuid4())},
    )


def details(client, cid):
    return client.get(f"/api/conversations/{cid}").json()


def patch(client, cid, **slots):
    return client.patch(f"/api/conversations/{cid}/workflow", json=slots)


class Weather:
    calls = []

    def forecast(self, city, day):
        self.calls.append((city, day))
        return {
            "city": city,
            "country": "Test country",
            "date": day.isoformat(),
            "high_c": 35,
            "low_c": 22,
            "rain_percent": 5,
            "wind_kmh": 12,
            "code": 0,
            "summary": "Clear sky",
            "source": "Open-Meteo (test fixture)",
            "fetched_at": datetime.now(UTC).isoformat(),
        }


def ready(client, cid):
    app.dependency_overrides[get_weather] = Weather
    response = patch(
        client,
        cid,
        city="Riyadh",
        date=(datetime.now(UTC).date() + timedelta(days=1)).isoformat(),
        activities="Walking and coffee",
        people=2,
    )
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "review"
    return response.json()


def test_conversation_and_browser_isolation(client):
    cid = conversation(client)
    assert details(client, cid)["messages"] == []
    assert len(client.get("/api/conversations").json()) == 1
    with TestClient(app) as stranger:
        assert stranger.get(f"/api/conversations/{cid}").status_code == 404
        assert stranger.get("/api/conversations").json() == []
        assert stranger.delete(f"/api/conversations/{cid}").status_code == 404
        assert (
            stranger.patch(
                f"/api/conversations/{cid}/workflow", json={"city": "London"}
            ).status_code
            == 404
        )


def test_workflow_commit_finishes_before_response_is_sent(client, monkeypatch):
    cid = conversation(client)
    assert client.post(f"/api/conversations/{cid}/workflow").status_code == 200
    events = []
    original_commit = Session.commit

    def record_commit(db):
        original_commit(db)
        events.append("commit")

    monkeypatch.setattr(Session, "commit", record_commit)

    async def observe_response(scope, receive, send):
        async def record_send(message):
            if message["type"] == "http.response.start":
                events.append("response")
            await send(message)

        await app(scope, receive, record_send)

    with TestClient(observe_response, cookies=dict(client.cookies)) as browser:
        response = browser.post(
            f"/api/conversations/{cid}/workflow/actions", json={"action": "pause"}
        )
    assert response.status_code == 200
    # A client may immediately reload after success; it must see committed state.
    assert events.index("commit") < events.index("response")
    assert details(client, cid)["workflow"]["status"] == "paused"


def test_explicit_memory_persists_across_conversations_and_browser_sessions(client):
    first = conversation(client)
    response = send(client, first, "Remember that I love quiet cafés")
    assert response.json()["kind"] == "memory"
    second = conversation(client)
    # A newly instantiated browser with the same persistent cookie is a new session.
    with TestClient(app, cookies=dict(client.cookies)) as returning:
        assert "quiet cafés" in send(returning, second, "what do you remember?").json()["content"]
        memories = returning.get("/api/memories").json()
        assert len(memories) == 1
        assert returning.delete(f"/api/memories/{memories[0]['id']}").status_code == 204
    assert client.get("/api/memories").json() == []


def test_memory_validation_and_deduplication(client):
    assert client.post("/api/memories", json={"content": " "}).status_code == 422
    assert client.post("/api/memories", json={"content": "x" * 501}).status_code == 422
    first = client.post("/api/memories", json={"content": "I like art"}).json()
    assert client.post("/api/memories", json={"content": "I like art"}).json()["id"] == first["id"]
    with TestClient(app) as stranger:
        assert stranger.delete(f"/api/memories/{first['id']}").status_code == 404


def test_missing_key_is_truthful_and_persisted(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "groq_api_key", "")
    cid = conversation(client)
    response = send(client, cid, "What is a black hole?")
    assert response.status_code == 200
    assert response.json()["kind"] == "error"
    assert response.json()["details"]["code"] == "credentials_missing"
    assert len(details(client, cid)["messages"]) == 2
    assert client.get("/api/session").json()["ai_configured"] is False


def test_message_idempotency_and_blank_validation(client):
    cid = conversation(client)
    request_id = str(uuid4())
    first = send(client, cid, "Remember that I like coffee", request_id).json()
    second = send(client, cid, "Remember that I like coffee", request_id).json()
    assert first["id"] == second["id"]
    assert len(details(client, cid)["messages"]) == 2
    assert send(client, cid, "A different message", request_id).status_code == 409
    assert send(client, cid, "  ").status_code == 422


def test_concurrent_message_retries_are_serialized(client):
    cid, request_id = conversation(client), str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as executor:
        replies = list(
            executor.map(
                lambda _: send(client, cid, "Remember that I like tea", request_id), range(2)
            )
        )
    assert all(response.status_code == 200 for response in replies)
    assert replies[0].json()["id"] == replies[1].json()["id"]
    assert len(details(client, cid)["messages"]) == 2


def test_workflow_collects_validates_corrects_and_confirms(client):
    cid = conversation(client)
    assert "city" in send(client, cid, "plan an outing").json()["content"]
    assert patch(client, cid, people=0).status_code == 422
    assert patch(client, cid, date="not-a-date").status_code == 422
    assert patch(client, cid, date="2000-01-01").status_code == 422
    assert (
        client.post(
            f"/api/conversations/{cid}/workflow/actions", json={"action": "confirm"}
        ).status_code
        == 409
    )
    assert "date" in send(client, cid, "city: Riyadh").json()["content"]
    ready(client, cid)
    assert client.get("/api/plans").json() == []
    correction = patch(client, cid, city="Jeddah").json()
    assert correction["weather"]["city"] == "Jeddah"
    assert "Jeddah" in correction["proposal"]
    assert "cooler morning" in correction["proposal"]
    for _ in range(2):
        assert (
            client.post(
                f"/api/conversations/{cid}/workflow/actions", json={"action": "confirm"}
            ).status_code
            == 200
        )
    assert len(client.get("/api/plans").json()) == 1
    assert details(client, cid)["workflow"]["status"] == "confirmed"
    assert patch(client, cid, city="London").status_code == 409


def test_interruptions_resume_and_state_persist(client):
    class Chat:
        def extract_memories(self, text):
            return []

        def complete(self, messages):
            assert "Saved memory" in messages[0]["content"]
            return {"content": "A black hole is a region of strong gravity."}

    app.dependency_overrides[get_groq] = Chat
    cid = conversation(client)
    send(client, cid, "plan an outing")
    send(client, cid, "city: Riyadh")
    before = details(client, cid)["workflow"]["slots"]
    reply = send(client, cid, "By the way, what is a black hole?").json()
    assert "gravity" in reply["content"]
    assert details(client, cid)["workflow"]["slots"] == before
    assert send(client, cid, "pause outing").json()["kind"] == "workflow"
    assert details(client, cid)["workflow"]["status"] == "paused"
    with TestClient(app, cookies=dict(client.cookies)) as returning:
        assert details(returning, cid)["workflow"]["status"] == "paused"
        assert "date" in send(returning, cid, "resume outing").json()["content"]
        assert details(returning, cid)["workflow"]["slots"]["city"] == "Riyadh"


def test_weather_outage_preserves_edits_and_removes_stale_proposal(client):
    class BrokenWeather:
        def forecast(self, city, day):
            raise ProviderError("Weather service unavailable", "weather_unavailable")

    cid = conversation(client)
    ready(client, cid)
    app.dependency_overrides[get_weather] = BrokenWeather
    assert patch(client, cid, city="London").status_code == 502
    workflow = details(client, cid)["workflow"]
    assert workflow["slots"]["city"] == "London"
    assert workflow["weather"] is None and workflow["proposal"] is None
    assert workflow["status"] == "collecting"
    assert client.get("/api/plans").json() == []
    assert (
        client.post(
            f"/api/conversations/{cid}/workflow/actions", json={"action": "confirm"}
        ).status_code
        == 409
    )


def test_cancel_and_restart(client):
    cid = conversation(client)
    send(client, cid, "plan an outing")
    send(client, cid, "city: Riyadh")
    send(client, cid, "cancel outing")
    assert details(client, cid)["workflow"]["status"] == "cancelled"
    assert patch(client, cid, city="London").status_code == 409
    send(client, cid, "restart outing")
    assert details(client, cid)["workflow"]["slots"] == {}


def test_clearing_field_invalidates_review(client):
    cid = conversation(client)
    ready(client, cid)
    result = patch(client, cid, activities=None).json()
    assert result["status"] == "collecting" and result["proposal"] is None


def test_delete_cascades_and_keeps_separate_memories(client):
    cid = conversation(client)
    send(client, cid, "Remember that I like museums")
    ready(client, cid)
    send(client, cid, "confirm plan")
    assert len(client.get("/api/plans").json()) == 1
    assert client.delete(f"/api/conversations/{cid}").status_code == 204
    assert client.get("/api/plans").json() == []
    assert len(client.get("/api/memories").json()) == 1


def test_model_tool_arguments_are_validated(client):
    class Chat:
        def extract_memories(self, text):
            return []

        def complete(self, messages):
            return {
                "tool_calls": [
                    {"function": {"name": "update_outing", "arguments": '{"people": 500}'}}
                ]
            }

    app.dependency_overrides[get_groq] = Chat
    cid = conversation(client)
    reply = send(client, cid, "Plan something for 500 people").json()
    assert reply["kind"] == "error"
    assert details(client, cid)["workflow"] is None


def test_model_outing_tool_persists_explicit_state(client):
    class Chat:
        def extract_memories(self, text):
            return []

        def complete(self, messages):
            return {
                "tool_calls": [
                    {
                        "function": {
                            "name": "update_outing",
                            "arguments": '{"city": "Riyadh", "activities": "Art"}',
                        }
                    }
                ]
            }

    app.dependency_overrides[get_groq] = Chat
    cid = conversation(client)
    assert send(client, cid, "I'd like an art outing in Riyadh").json()["kind"] == "workflow"
    assert details(client, cid)["workflow"]["slots"] == {"city": "Riyadh", "activities": "Art"}


def test_model_weather_tool_fetches_provider_data(client):
    import json

    day = (datetime.now(UTC).date() + timedelta(days=1)).isoformat()

    class Chat:
        def extract_memories(self, text):
            return []

        def complete(self, messages):
            return {
                "tool_calls": [
                    {
                        "function": {
                            "name": "weather",
                            "arguments": json.dumps({"city": "Riyadh", "date": day}),
                        }
                    }
                ]
            }

    app.dependency_overrides[get_groq] = Chat
    app.dependency_overrides[get_weather] = Weather
    cid = conversation(client)
    reply = send(client, cid, "Will it rain in Riyadh tomorrow?").json()
    assert reply["kind"] == "weather"
    assert reply["details"]["rain_percent"] == 5
    assert "35°C" in reply["content"]


def test_model_receives_memory_in_new_conversation(client):
    class Chat:
        def extract_memories(self, text):
            return []

        def complete(self, messages):
            assert "I prefer museums" in messages[0]["content"]
            return {"content": "You might enjoy a museum."}

    app.dependency_overrides[get_groq] = Chat
    send(client, conversation(client), "Remember that I prefer museums")
    assert (
        "museum" in send(client, conversation(client), "Suggest something for me").json()["content"]
    )


def test_transcription_validation_and_adapter(client):
    class Speech:
        def transcribe(self, audio, filename, content_type, language="auto"):
            assert audio == b"test-audio" and filename == "recording.webm"
            return "Hello Sarjy"

    app.dependency_overrides[get_groq] = Speech
    assert client.post(
        "/api/transcriptions", files={"file": ("voice.webm", b"test-audio", "audio/webm")}
    ).json() == {"text": "Hello Sarjy"}
    assert (
        client.post(
            "/api/transcriptions", files={"file": ("bad.txt", b"text", "text/plain")}
        ).status_code
        == 415
    )
    assert (
        client.post(
            "/api/transcriptions", files={"file": ("empty.webm", b"", "audio/webm")}
        ).status_code
        == 413
    )
    assert (
        client.post(
            "/api/transcriptions",
            files={"file": ("large.webm", b"x" * (10 * 1024 * 1024 + 1), "audio/webm")},
        ).status_code
        == 413
    )


def test_cross_origin_write_rejected(client):
    assert (
        client.post("/api/conversations", headers={"origin": "https://evil.example"}).status_code
        == 403
    )
    assert (
        client.post("/api/conversations", headers={"origin": get_settings().app_origin}).status_code
        == 201
    )


def test_stale_forecast_requires_another_review(client, test_engine):
    from sqlalchemy.orm import Session

    from app.models import Workflow

    cid = conversation(client)
    workflow = ready(client, cid)
    with Session(test_engine) as db:
        saved = db.get(Workflow, workflow["id"])
        saved.weather = {
            **saved.weather,
            "fetched_at": (datetime.now(UTC) - timedelta(hours=1)).isoformat(),
        }
        db.commit()
    response = client.post(f"/api/conversations/{cid}/workflow/actions", json={"action": "confirm"})
    assert response.status_code == 409
    assert response.json()["code"] == "forecast_refreshed"
    assert client.get("/api/plans").json() == []
    assert details(client, cid)["workflow"]["status"] == "review"
    assert (
        client.post(
            f"/api/conversations/{cid}/workflow/actions", json={"action": "confirm"}
        ).status_code
        == 200
    )


def test_transcription_missing_key(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "groq_api_key", "")
    response = client.post(
        "/api/transcriptions", files={"file": ("voice.webm", b"audio", "audio/webm")}
    )
    assert response.status_code == 503
    assert response.json()["code"] == "credentials_missing"


def test_silent_wav_never_reaches_whisper(client):
    import io
    import wave

    audio = io.BytesIO()
    with wave.open(audio, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(b"\0" * (16000 * 2 * 4))

    class Speech:
        def transcribe(self, *args):
            raise AssertionError("Silence must be rejected before the provider")

    app.dependency_overrides[get_groq] = Speech
    response = client.post(
        "/api/transcriptions", files={"file": ("silence.wav", audio.getvalue(), "audio/wav")}
    )
    assert response.status_code == 422 and response.json()["code"] == "no_speech"


def test_arabic_transcription_hint_and_memory(client):
    class Speech:
        def transcribe(self, audio, filename, content_type, language):
            assert language == "ar"
            return "تذكر أن لوني المفضل أزرق"

    app.dependency_overrides[get_groq] = Speech
    response = client.post(
        "/api/transcriptions",
        data={"language": "ar"},
        files={"file": ("voice.webm", b"audio", "audio/webm")},
    )
    cid = conversation(client)
    reply = send(client, cid, response.json()["text"]).json()
    assert reply["kind"] == "memory" and reply["content"].startswith("حفظت")
    assert client.get("/api/memories").json()[0]["content"] == "لوني المفضل أزرق"
    assert "أزرق" in send(client, conversation(client), "ماذا تتذكر عني؟").json()["content"]
    assert (
        client.post(
            "/api/transcriptions",
            data={"language": "invalid"},
            files={"file": ("voice.webm", b"audio", "audio/webm")},
        ).status_code
        == 422
    )


def test_speech_only_reads_owned_assistant_messages(client):
    calls = []

    class Speech:
        def speech(self, text):
            calls.append(text)
            return b"RIFF-test-audio"

    app.dependency_overrides[get_groq] = Speech
    cid = conversation(client)
    reply = send(client, cid, "Remember that " + "I enjoy walking. " * 25).json()
    response = client.post(f"/api/messages/{reply['id']}/speech")
    assert response.status_code == 200 and response.headers["content-type"] == "audio/wav"
    parts = int(response.headers["x-speech-parts"])
    assert parts > 1 and len(calls[0]) <= 200
    for part in range(1, parts):
        assert client.post(f"/api/messages/{reply['id']}/speech?part={part}").status_code == 200
    assert " ".join(calls) == reply["content"]
    assert client.post(f"/api/messages/{reply['id']}/speech?part={parts}").status_code == 404
    user = details(client, cid)["messages"][0]
    assert client.post(f"/api/messages/{user['id']}/speech").status_code == 404
    with TestClient(app) as other:
        assert other.post(f"/api/messages/{reply['id']}/speech").status_code == 404


def test_arabic_workflow_prompts_and_explicit_controls(client):
    cid = conversation(client)
    assert "مدينة" in send(client, cid, "خطط لنزهة").json()["content"]
    paused = send(client, cid, "أوقف النزهة").json()
    assert paused["kind"] == "workflow" and "متوقفة" in paused["content"]
    resumed = send(client, cid, "استأنف النزهة").json()
    assert "مدينة" in resumed["content"]
    ready(client, cid)
    review = send(client, cid, "استأنف النزهة").json()
    assert "درجة مئوية" in review["content"] and "أكد الخطة" in review["content"]
    assert "تأكيد" in send(client, cid, "أكد الخطة").json()["content"]


def test_explicit_arabic_language_reaches_the_model(client):
    class Chat:
        def extract_memories(self, text):
            return []

        def complete(self, messages):
            assert "Respond in Arabic" in messages[0]["content"]
            return {"content": "مرحبا بك"}

    app.dependency_overrides[get_groq] = Chat
    response = client.post(
        f"/api/conversations/{conversation(client)}/messages",
        json={"content": "Hello", "request_id": str(uuid4()), "language": "ar"},
    )
    assert response.json()["content"] == "مرحبا بك"


class MemoryChat:
    facts = []
    seen = []

    def extract_memories(self, text):
        return self.facts

    def complete(self, messages):
        self.seen.append(messages[0]["content"])
        return {"content": "Understood."}


def test_automatic_memory_is_grounded_deduplicated_and_correctable(client):
    chat = MemoryChat()
    app.dependency_overrides[get_groq] = lambda: chat
    cid = conversation(client)
    chat.facts = [
        {"category": "name", "text": "My name is Sam"},
        {"category": "availability", "text": "I am only free at weekends"},
        {"category": "preference", "text": "invented quote"},
    ]
    send(client, cid, "My name is Sam. I am only free at weekends")
    memories = client.get("/api/memories").json()
    assert {m["content"] for m in memories} == {"My name is Sam", "I am only free at weekends"}
    assert "My name is Sam" in chat.seen[-1]
    send(client, cid, "My name is Sam. I am only free at weekends")
    assert len(client.get("/api/memories").json()) == 2
    chat.facts = [{"category": "name", "text": "My name is Sara"}]
    send(client, cid, "My name is Sara")
    assert {m["content"] for m in client.get("/api/memories").json()} == {
        "My name is Sara",
        "I am only free at weekends",
    }
    first = client.get("/api/memories").json()[0]
    client.delete(f"/api/memories/{first['id']}")
    chat.facts = []
    send(client, conversation(client), "Hello again")
    assert len(client.get("/api/memories").json()) == 1


def test_arabic_auto_memory_and_do_not_remember(client):
    chat = MemoryChat()
    app.dependency_overrides[get_groq] = lambda: chat
    chat.facts = [
        {"category": "name", "text": "اسمي محمد"},
        {"category": "availability", "text": "أنا متفرغ في نهاية الأسبوع فقط"},
    ]
    cid = conversation(client)
    send(client, cid, "اسمي محمد. أنا متفرغ في نهاية الأسبوع فقط")
    assert len(client.get("/api/memories").json()) == 2
    chat.facts = [{"category": "preference", "text": "I like coffee"}]
    send(client, cid, "Do not remember this: I like coffee")
    assert len(client.get("/api/memories").json()) == 2


@pytest.mark.parametrize("quote", ["My favorite color is blue.", "لوني المفضل هو الأزرق."])
def test_favorite_color_is_captured_and_included_in_a_new_conversation(client, quote):
    chat = MemoryChat()
    app.dependency_overrides[get_groq] = lambda: chat
    chat.facts = [{"category": "preference", "text": quote}]
    send(client, conversation(client), quote)
    assert [m["content"] for m in client.get("/api/memories").json()] == [quote]
    chat.facts = []
    send(client, conversation(client), "What is my favorite color?")
    assert quote in chat.seen[-1]


def test_memory_extraction_outage_does_not_break_chat(client):
    class Chat(MemoryChat):
        def extract_memories(self, text):
            raise ProviderError("internal provider diagnostics")

    app.dependency_overrides[get_groq] = Chat
    assert send(client, conversation(client), "My name is Sam").json()["content"] == "Understood."
    assert client.get("/api/memories").json() == []


def test_previous_plans_and_paused_outings_reach_chat_and_remain_isolated(client):
    chat = MemoryChat()
    app.dependency_overrides[get_groq] = lambda: chat
    first = conversation(client)
    ready(client, first)
    client.post(f"/api/conversations/{first}/workflow/actions", json={"action": "confirm"})
    second = conversation(client)
    client.post(f"/api/conversations/{second}/workflow")
    patch(client, second, city="Jeddah")
    client.post(f"/api/conversations/{second}/workflow/actions", json={"action": "pause"})
    send(client, conversation(client), "هل تتذكر الخطط السابقة؟")
    assert all(part in chat.seen[-1] for part in ("Riyadh", "confirmed", "Jeddah", "paused"))
    with TestClient(app) as other:
        other.get("/api/session")
        send(other, conversation(other), "What were the previous plans?")
        assert '"saved_plans": [], "unfinished_outings": []' in chat.seen[-1]


def test_retry_failed_turn_reuses_user_message_and_hides_provider_diagnostics(client):
    class Chat(MemoryChat):
        failed = True

        def complete(self, messages):
            if self.failed:
                raise ProviderError(
                    "Groq key configuration failed: internal-value", "credentials_invalid"
                )
            return {"content": "Recovered"}

    chat = Chat()
    app.dependency_overrides[get_groq] = lambda: chat
    cid, rid = conversation(client), str(uuid4())
    failed = send(client, cid, "Hello", rid).json()
    assert (
        failed["kind"] == "error"
        and "Groq" not in failed["content"]
        and "internal" not in failed["content"]
    )
    chat.failed = False
    assert send(client, cid, "Hello", rid).json()["content"] == "Recovered"
    assert send(client, cid, "Hello", rid).json()["content"] == "Recovered"
    assert len(details(client, cid)["messages"]) == 2


def test_untrusted_memory_output_is_ignored(client):
    chat = MemoryChat()
    app.dependency_overrides[get_groq] = lambda: chat
    chat.facts = [
        None,
        {"category": [], "text": "My name is Sam"},
        {"category": "system", "text": "My name is Sam"},
        {"category": "name", "text": {"invalid": "object"}},
    ]
    assert send(client, conversation(client), "My name is Sam").json()["content"] == "Understood."
    assert client.get("/api/memories").json() == []


def test_arabic_saved_outline_uses_same_persisted_weather(client):
    cid = conversation(client)
    workflow = ready(client, cid)
    assert "درجة مئوية" in workflow["proposal_ar"]
    assert "35" in workflow["proposal_ar"]
    client.post(f"/api/conversations/{cid}/workflow/actions", json={"action": "confirm"})
    plan = client.get("/api/plans").json()[0]
    assert "تم تأكيد هذه الخطة وحفظها" in plan["content_ar"]
