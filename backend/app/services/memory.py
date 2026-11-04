"""Capture explicit personal facts; retrieve only the current workspace's history."""

import logging
import re

from sqlalchemy import select

from app.models import Conversation, Memory, Plan, Workflow
from app.providers.errors import ProviderError

logger = logging.getLogger(__name__)
CATEGORIES = {"name", "availability", "home_city", "preference"}


def capture_memories(db, conversation, text, groq):
    # Only inspect this new user turn. Deleted memories are never rebuilt from old chats.
    if re.search(r"don't remember|do not (?:save|remember)|لا (?:تحفظ|تتذكر)|لا تتذكر", text, re.I):
        return
    if re.match(r"(?:remember|تذكر|احفظ)\b", text, re.I):
        return  # Explicit saves are handled by the deterministic chat command.
    if not re.search(
        r"\b(?:I|my)\b|أنا|انا|اسمي|أحب|احب|أفضل|افضل|المفضل|متفرغ|متاح|عندي|وقتي|دوامي", text, re.I
    ):
        return
    try:
        facts = groq.extract_memories(text)
    except ProviderError as exc:
        # Memory is best effort. A transient extraction failure must not break the reply.
        logger.warning("Memory extraction unavailable: code=%s", exc.code)
        return
    existing = list(
        db.scalars(select(Memory).where(Memory.workspace_id == conversation.workspace_id))
    )
    for fact in facts:
        if not isinstance(fact, dict):
            continue
        category, quote = fact.get("category"), fact.get("text")
        if (
            not isinstance(category, str)
            or category not in CATEGORIES
            or not isinstance(quote, str)
        ):
            continue
        quote = quote.strip()
        # Model-generated summaries and invented facts cannot be stored.
        if not 3 <= len(quote) <= 500 or quote not in text:
            continue
        if any(m.content.casefold() == quote.casefold() for m in existing):
            continue
        key = category if category != "preference" else None
        previous = next((m for m in existing if key and m.fact_key == key), None)
        if previous:
            previous.content = quote
        elif len(existing) < 100:
            memory = Memory(workspace_id=conversation.workspace_id, content=quote, fact_key=key)
            db.add(memory)
            existing.append(memory)
    db.flush()


def past_outings(db, workspace_id):
    plans = db.scalars(
        select(Plan)
        .where(Plan.workspace_id == workspace_id)
        .order_by(Plan.created_at.desc())
        .limit(20)
    ).all()
    drafts = db.scalars(
        select(Workflow)
        .join(Conversation)
        .where(
            Conversation.workspace_id == workspace_id,
            Workflow.status.in_(["collecting", "review", "paused"]),
        )
        .order_by(Workflow.updated_at.desc())
        .limit(20)
    ).all()
    return {
        "saved_plans": [
            {"status": "confirmed", "slots": p.slots, "saved_at": p.created_at.isoformat()}
            for p in plans
        ],
        "unfinished_outings": [{"status": w.status, "slots": w.slots} for w in drafts],
    }
