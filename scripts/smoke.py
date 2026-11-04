#!/usr/bin/env python3
"""Real Compose smoke test. Never mocks weather. State file contains only this test workspace's cookie.

python3 scripts/smoke.py seed --state /tmp/sarjy-smoke.json
docker compose restart db backend
python3 scripts/smoke.py verify --state /tmp/sarjy-smoke.json
python3 scripts/smoke.py cleanup --state /tmp/sarjy-smoke.json
"""
import argparse
import http.cookiejar
import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import uuid4
from zoneinfo import ZoneInfo

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("phase", choices=["seed", "verify", "cleanup"])
parser.add_argument("--state", type=Path, required=True)
parser.add_argument("--url", default="http://localhost:3000")
args = parser.parse_args()
jar = http.cookiejar.CookieJar()
http = build_opener(HTTPCookieProcessor(jar))
state = json.loads(args.state.read_text()) if args.state.exists() else {}


def request(path, method="GET", body=None):
    headers = {"Content-Type": "application/json"}
    if state.get("cookie"):
        headers["Cookie"] = state["cookie"]
    req = Request(args.url + "/api" + path, method=method, headers=headers, data=json.dumps(body).encode() if body is not None else None)
    with http.open(req, timeout=70) as response:
        payload = response.read()
        return json.loads(payload) if payload else None


def save():
    fd = os.open(args.state, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump(state, file)


if args.phase == "seed":
    if state:
        raise SystemExit("State file exists. Verify and clean up that run first.")
    assert request("/health") == {"status": "ok", "database": "connected"}
    session = request("/session")
    state = {"cookie": "; ".join(f"{c.name}={c.value}" for c in jar), "conversations": [], "memory_ids": []}
    save()
    first = request("/conversations", "POST")["id"]
    state["conversations"].append(first)
    save()
    memory = request("/memories", "POST", {"content": "Smoke test: I enjoy art and quiet cafés"})
    state["memory_ids"].append(memory["id"])
    second = request("/conversations", "POST")["id"]
    state["conversations"].append(second)
    save()
    reply = request(f"/conversations/{second}/messages", "POST", {"content": "what do you remember?", "request_id": str(uuid4())})
    assert "quiet cafés" in reply["content"]
    request(f"/conversations/{first}/workflow", "POST")
    request(f"/conversations/{first}/workflow", "PATCH", {"city": "Riyadh"})
    request(f"/conversations/{first}/workflow/actions", "POST", {"action": "pause"})
    assert request(f"/conversations/{first}")["workflow"]["status"] == "paused"
    request(f"/conversations/{first}/workflow/actions", "POST", {"action": "resume"})
    day = datetime.now(ZoneInfo(session["timezone"])).date() + timedelta(days=1)
    workflow = request(f"/conversations/{first}/workflow", "PATCH", {"date": day.isoformat(), "activities": "Art and coffee", "people": 2})
    assert workflow["status"] == "review" and workflow["weather"]["source"] == "Open-Meteo"
    assert request("/plans") == []  # No save before explicit confirmation.
    corrected = request(f"/conversations/{first}/workflow", "PATCH", {"people": 3})
    assert corrected["slots"]["people"] == 3
    request(f"/conversations/{first}/workflow/actions", "POST", {"action": "confirm"})
    state["plan_id"] = request("/plans")[0]["id"]
    save()
    print("PASS: same-origin proxy, PostgreSQL, cross-conversation memory, partial workflow, pause/resume, REAL Open-Meteo forecast, corrections, explicit confirmation.")
    print(json.dumps({key: workflow["weather"][key] for key in ("source", "city", "date", "high_c", "low_c", "fetched_at")}))
elif args.phase == "verify":
    assert state, "Seed the test first"
    assert request("/health")["database"] == "connected"
    assert {c["id"] for c in request("/conversations")} == set(state["conversations"])
    assert state["memory_ids"][0] in {m["id"] for m in request("/memories")}
    assert state["plan_id"] in {p["id"] for p in request("/plans")}
    assert request(f"/conversations/{state['conversations'][0]}")["workflow"]["status"] == "confirmed"
    print("PASS: conversations, memory, workflow, and confirmed plan survive service restarts.")
else:
    assert state, "No smoke state file"
    for cid in state["conversations"]:
        request(f"/conversations/{cid}", "DELETE")
    for mid in state["memory_ids"]:
        request(f"/memories/{mid}", "DELETE")
    assert request("/conversations") == [] and request("/memories") == [] and request("/plans") == []
    args.state.unlink()
    print("PASS: smoke-test conversations, memories, and plans removed.")
