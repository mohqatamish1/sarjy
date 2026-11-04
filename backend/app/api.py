import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Form, HTTPException, Query, Request, Response, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import Conversation, Memory, Message, Plan, Workspace, now
from app.providers.errors import ProviderError, public_message
from app.providers.groq import GroqProvider, get_groq
from app.providers.weather import WeatherProvider, get_weather
from app.schemas import (
    ConversationDetail,
    ConversationOut,
    MemoryIn,
    MemoryOut,
    MessageOut,
    PlanOut,
    SendMessage,
    Slots,
    WorkflowAction,
    WorkflowOut,
)
from app.services.audio import speech_chunks, validate_wav
from app.services.chat import respond
from app.services.memory import capture_memories
from app.services.workflow import act_on_workflow, get_workflow, update_workflow

router = APIRouter(prefix="/api")
COOKIE = "sarjy_session"


def workspace(
    request: Request, response: Response, db: Session = Depends(get_db, scope="function")
) -> Workspace:
    token = request.cookies.get(COOKIE, "")
    found = (
        db.scalar(
            select(Workspace).where(
                Workspace.token_hash == hashlib.sha256(token.encode()).hexdigest()
            )
        )
        if token
        else None
    )
    if not found:
        token = secrets.token_urlsafe(32)
        found = Workspace(token_hash=hashlib.sha256(token.encode()).hexdigest())
        db.add(found)
        db.commit()
        response.set_cookie(
            COOKIE,
            token,
            max_age=60 * 60 * 24 * 365,
            httponly=True,
            secure=get_settings().cookie_secure,
            samesite="strict",
            path="/",
        )
    # Serialize writes for one anonymous workspace, including duplicate chat requests.
    if request.method != "GET":
        db.scalar(select(Workspace).where(Workspace.id == found.id).with_for_update())
    return found


def owned_conversation(conversation_id: str, db: Session, owner: Workspace) -> Conversation:
    conversation = db.scalar(
        select(Conversation).where(
            Conversation.id == conversation_id, Conversation.workspace_id == owner.id
        )
    )
    if conversation is None:
        raise HTTPException(404, "Conversation not found")
    return conversation


@router.get("/session")
def session_info(owner: Workspace = Depends(workspace)):
    settings = get_settings()
    return {
        "workspace_id": owner.id,
        "ai_configured": bool(settings.groq_api_key),
        "timezone": settings.app_timezone,
        "today": datetime.now(UTC).isoformat(),
        "mode": "live",
        "memory_policy": "Useful personal facts are remembered automatically. View and remove them in Memory.",
    }


@router.get("/conversations", response_model=list[ConversationOut])
def conversations(
    db: Session = Depends(get_db, scope="function"), owner: Workspace = Depends(workspace)
):
    return db.scalars(
        select(Conversation)
        .where(Conversation.workspace_id == owner.id)
        .order_by(Conversation.updated_at.desc())
        .limit(100)
    ).all()


@router.post("/conversations", response_model=ConversationOut, status_code=201)
def create_conversation(
    db: Session = Depends(get_db, scope="function"), owner: Workspace = Depends(workspace)
):
    conversation = Conversation(workspace_id=owner.id)
    db.add(conversation)
    db.commit()
    return conversation


@router.get("/conversations/{conversation_id}", response_model=ConversationDetail)
def conversation_detail(
    conversation_id: UUID,
    db: Session = Depends(get_db, scope="function"),
    owner: Workspace = Depends(workspace),
):
    conversation = owned_conversation(str(conversation_id), db, owner)
    return {
        **ConversationOut.model_validate(conversation).model_dump(),
        "messages": db.scalars(
            select(Message)
            .where(Message.conversation_id == conversation.id)
            .order_by(Message.created_at, Message.id)
        ).all(),
        "workflow": get_workflow(db, conversation),
    }


@router.delete("/conversations/{conversation_id}", status_code=204)
def delete_conversation(
    conversation_id: UUID,
    db: Session = Depends(get_db, scope="function"),
    owner: Workspace = Depends(workspace),
):
    db.delete(owned_conversation(str(conversation_id), db, owner))
    db.commit()


@router.post("/conversations/{conversation_id}/messages", response_model=MessageOut)
def send_message(
    conversation_id: UUID,
    body: SendMessage,
    db: Session = Depends(get_db, scope="function"),
    owner: Workspace = Depends(workspace),
    groq: GroqProvider = Depends(get_groq),
    weather: WeatherProvider = Depends(get_weather),
):
    conversation = owned_conversation(str(conversation_id), db, owner)
    request_id = str(body.request_id)
    existing = db.scalar(
        select(Message).where(
            Message.conversation_id == conversation.id,
            Message.request_id == request_id,
            Message.role == "assistant",
        )
    )
    if existing:
        original = db.scalar(
            select(Message).where(
                Message.conversation_id == conversation.id,
                Message.request_id == request_id,
                Message.role == "user",
            )
        )
        if original and original.content != body.content:
            raise HTTPException(409, "This request ID belongs to a different message")
        if existing.kind != "error":
            return existing
        db.delete(existing)
        db.flush()
    # Simple persisted rate limit protects a key on a public instance. Add identity-based limits before multi-user production.
    recent = db.scalar(
        select(func.count(Message.id)).where(
            Message.conversation_id.in_(
                select(Conversation.id).where(Conversation.workspace_id == owner.id)
            ),
            Message.role == "user",
            Message.created_at > now() - timedelta(minutes=1),
        )
    )
    if recent and recent >= 20:
        raise HTTPException(429, "Please wait a moment before sending another message")
    user_message = db.scalar(
        select(Message).where(
            Message.conversation_id == conversation.id,
            Message.request_id == request_id,
            Message.role == "user",
        )
    )
    if not user_message:
        db.add(
            Message(
                conversation_id=conversation.id,
                request_id=request_id,
                role="user",
                content=body.content,
            )
        )
        if conversation.title == "New conversation":
            conversation.title = body.content[:75]
        conversation.updated_at = now()
        db.flush()
    capture_memories(db, conversation, body.content, groq)
    try:
        content, kind, details = respond(
            db, conversation, body.content, groq, weather, body.language
        )
    except ProviderError as exc:
        logging.getLogger(__name__).warning("Chat provider failure: code=%s", exc.code)
        content, kind, details = public_message(exc.code), "error", {"code": exc.code}
    reply = Message(
        conversation_id=conversation.id,
        request_id=request_id,
        role="assistant",
        content=content,
        kind=kind,
        details=details,
    )
    db.add(reply)
    conversation.updated_at = now()
    db.commit()
    return reply


@router.get("/memories", response_model=list[MemoryOut])
def memories(
    db: Session = Depends(get_db, scope="function"), owner: Workspace = Depends(workspace)
):
    return db.scalars(
        select(Memory).where(Memory.workspace_id == owner.id).order_by(Memory.created_at)
    ).all()


@router.post("/memories", response_model=MemoryOut, status_code=201)
def add_memory(
    body: MemoryIn,
    db: Session = Depends(get_db, scope="function"),
    owner: Workspace = Depends(workspace),
):
    memory = db.scalar(
        select(Memory).where(Memory.workspace_id == owner.id, Memory.content == body.content)
    )
    if not memory:
        if db.scalar(select(func.count(Memory.id)).where(Memory.workspace_id == owner.id)) >= 100:
            raise HTTPException(
                422, "You can save up to 100 memories. Remove one before adding another."
            )
        memory = Memory(workspace_id=owner.id, content=body.content)
        db.add(memory)
        db.commit()
    return memory


@router.delete("/memories/{memory_id}", status_code=204)
def delete_memory(
    memory_id: UUID,
    db: Session = Depends(get_db, scope="function"),
    owner: Workspace = Depends(workspace),
):
    memory = db.scalar(
        select(Memory).where(Memory.id == str(memory_id), Memory.workspace_id == owner.id)
    )
    if not memory:
        raise HTTPException(404, "Memory not found")
    db.delete(memory)
    db.commit()


@router.post("/conversations/{conversation_id}/workflow", response_model=WorkflowOut)
def start_workflow(
    conversation_id: UUID,
    db: Session = Depends(get_db, scope="function"),
    owner: Workspace = Depends(workspace),
):
    conversation = owned_conversation(str(conversation_id), db, owner)
    workflow = get_workflow(db, conversation, True)
    if conversation.title == "New conversation":
        conversation.title = "A new outing"
    conversation.updated_at = now()
    db.commit()
    return workflow


@router.patch("/conversations/{conversation_id}/workflow", response_model=WorkflowOut)
def patch_workflow(
    conversation_id: UUID,
    body: Slots,
    db: Session = Depends(get_db, scope="function"),
    owner: Workspace = Depends(workspace),
    weather: WeatherProvider = Depends(get_weather),
):
    return update_workflow(db, owned_conversation(str(conversation_id), db, owner), body, weather)


@router.post("/conversations/{conversation_id}/workflow/actions", response_model=WorkflowOut)
def workflow_action(
    conversation_id: UUID,
    body: WorkflowAction,
    db: Session = Depends(get_db, scope="function"),
    owner: Workspace = Depends(workspace),
    weather: WeatherProvider = Depends(get_weather),
):
    return act_on_workflow(
        db, owned_conversation(str(conversation_id), db, owner), body.action, weather
    )


@router.get("/plans", response_model=list[PlanOut])
def plans(db: Session = Depends(get_db, scope="function"), owner: Workspace = Depends(workspace)):
    return db.scalars(
        select(Plan).where(Plan.workspace_id == owner.id).order_by(Plan.created_at.desc())
    ).all()


@router.post("/transcriptions")
def transcribe(
    file: UploadFile,
    language: Literal["auto", "en", "ar"] = Form("auto"),
    owner: Workspace = Depends(workspace),
    groq: GroqProvider = Depends(get_groq),
):
    allowed = {
        "audio/webm",
        "video/webm",
        "audio/ogg",
        "audio/mp4",
        "video/mp4",
        "audio/mpeg",
        "audio/wav",
        "audio/x-wav",
    }
    content_type = (file.content_type or "").split(";")[0]
    if content_type not in allowed:
        raise HTTPException(415, "Record or upload WebM, Ogg, MP4, MP3, or WAV audio")
    data = file.file.read(10 * 1024 * 1024 + 1)
    if not data or len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "Audio must be between 1 byte and 10 MB")
    suffix = {
        "audio/webm": "webm",
        "video/webm": "webm",
        "audio/ogg": "ogg",
        "audio/mp4": "mp4",
        "video/mp4": "mp4",
        "audio/mpeg": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
    }[content_type]
    if suffix == "wav":
        validate_wav(data)
    return {"text": groq.transcribe(data, f"recording.{suffix}", content_type, language)}


@router.post("/messages/{message_id}/speech")
def speak_message(
    message_id: UUID,
    part: int = Query(0, ge=0),
    db: Session = Depends(get_db, scope="function"),
    owner: Workspace = Depends(workspace),
    groq: GroqProvider = Depends(get_groq),
):
    # Only synthesize an authorized, stored assistant reply, never arbitrary user-supplied text.
    message = db.scalar(
        select(Message)
        .join(Conversation)
        .where(
            Message.id == str(message_id),
            Conversation.workspace_id == owner.id,
            Message.role == "assistant",
            Message.kind != "error",
        )
    )
    if message is None:
        raise HTTPException(404, "Assistant message not found")
    chunks = speech_chunks(message.content)
    if part >= len(chunks):
        raise HTTPException(404, "Speech part not found")
    return Response(
        groq.speech(chunks[part]),
        media_type="audio/wav",
        headers={"X-Speech-Parts": str(len(chunks))},
    )
