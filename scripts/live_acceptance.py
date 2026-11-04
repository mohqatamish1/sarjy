#!/usr/bin/env python3
"""Opt-in development acceptance with real Groq/Open-Meteo (small provider usage).

Run: python3 scripts/live_acceptance.py --url http://localhost:3000
Uses a new cookie/workspace, cleans only its own data, and never restarts services.
"""
import argparse
import http.cookiejar
import json
from datetime import datetime, timedelta
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import uuid4
from zoneinfo import ZoneInfo

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="http://localhost:3000")
args = parser.parse_args()
jar = http.cookiejar.CookieJar()
client = build_opener(HTTPCookieProcessor(jar))
ids = []


def call(path, method="GET", data=None):
    req = Request(
        args.url + "/api" + path,
        method=method,
        headers={"Content-Type": "application/json"},
        data=json.dumps(data).encode() if data is not None else None,
    )
    with client.open(req, timeout=70) as response:
        body = response.read()
        return json.loads(body) if body else None


def conversation():
    cid = call("/conversations", "POST")["id"]
    ids.append(cid)
    return cid


def say(cid, content):
    reply = call(f"/conversations/{cid}/messages", "POST", {
        "content": content, "request_id": str(uuid4()),
    })
    assert reply["kind"] != "error", reply
    print(reply["content"], flush=True)
    return reply["content"]


try:
    session = call("/session")
    assert session["ai_configured"], "Configure the server-side Groq key first"
    assert call("/health")["database"] == "connected"
    say(conversation(), "My name is Maya. I am only free on weekends. I prefer quiet museums.")
    facts = call("/memories")
    assert any("Maya" in m["content"] for m in facts)
    assert any("weekend" in m["content"].lower() for m in facts)
    # Reopen the same anonymous workspace with a fresh HTTP client, then a new conversation.
    client = build_opener(HTTPCookieProcessor(jar))
    reply = say(conversation(), "What is my name and when am I free?")
    assert "Maya" in reply and "weekend" in reply.lower()
    say(conversation(), "اسمي نور. أنا متفرغ في نهاية الأسبوع فقط وأفضل الأماكن الهادئة.")
    facts = call("/memories")
    assert any("نور" in m["content"] for m in facts)
    assert not any("Maya" in m["content"] for m in facts)
    reply = say(conversation(), "ما اسمي ومتى أكون متفرغا؟")
    assert "نور" in reply and "الأسبوع" in reply
    assert "اسمي نور" not in reply, "The assistant must address the user's name, not adopt it"
    print("PASS: automatic memory, correction, English/Arabic new-conversation recall.", flush=True)

    outing = conversation()
    day = (datetime.now(ZoneInfo(session["timezone"])).date() + timedelta(days=1)).isoformat()
    say(outing, "plan an outing")
    say(outing, f"I want to visit Riyadh on {day}, for museums and coffee, with two people.")
    workflow = call(f"/conversations/{outing}")["workflow"]
    assert workflow["status"] == "review" and workflow["slots"]["people"] == 2
    assert workflow["weather"]["source"] == "Open-Meteo" and workflow["proposal_ar"]
    assert call("/plans") == []
    say(outing, "pause outing")
    say(outing, "Why is the sky blue? Answer briefly.")
    paused = call(f"/conversations/{outing}")["workflow"]
    assert paused["status"] == "paused" and paused["slots"] == workflow["slots"]
    say(outing, "resume outing")
    say(outing, "Actually there will be three people instead of two.")
    assert call(f"/conversations/{outing}")["workflow"]["slots"]["people"] == 3
    say(outing, "confirm plan")
    assert len(call("/plans")) == 1 and call("/plans")[0]["slots"]["people"] == 3
    unfinished = conversation()
    call(f"/conversations/{unfinished}/workflow", "POST")
    call(f"/conversations/{unfinished}/workflow", "PATCH", {"city": "Jeddah"})
    call(f"/conversations/{unfinished}/workflow/actions", "POST", {"action": "pause"})
    reply = say(conversation(), "اذكر كل النزهات السابقة، المؤكدة وغير المكتملة، مع المدينة وحالة كل منها.")
    assert "الرياض" in reply or "Riyadh" in reply
    assert "جدة" in reply or "Jeddah" in reply
    assert "مؤكد" in reply and ("معلق" in reply or "متوقف" in reply or "مكتمل" in reply)
    print("PASS: natural-language workflow, real weather, pause/off-topic/resume, correction, confirmation, past confirmed/unfinished plan recall.", flush=True)

    before = call("/memories")
    say(conversation(), "Do not remember this: my home city is Tokyo.")
    assert call("/memories") == before
    name = next(m for m in before if "نور" in m["content"])
    call("/memories/" + name["id"], "DELETE")
    say(conversation(), "Hello, how are you?")
    assert not any("نور" in m["content"] for m in call("/memories"))
    stranger = build_opener(HTTPCookieProcessor(http.cookiejar.CookieJar()))
    with stranger.open(args.url + "/api/session", timeout=20):
        pass
    for resource in ("memories", "plans", "conversations"):
        with stranger.open(args.url + "/api/" + resource, timeout=20) as response:
            assert json.load(response) == []
    print("PASS: opt-out, deletion without historical recapture, independent-workspace isolation.", flush=True)
finally:
    for cid in ids:
        call("/conversations/" + cid, "DELETE")
    for memory in call("/memories"):
        call("/memories/" + memory["id"], "DELETE")
    assert call("/conversations") == [] and call("/memories") == [] and call("/plans") == []
    print("CLEANUP: only this test workspace's conversations, memories and plans removed.", flush=True)
