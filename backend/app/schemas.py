from datetime import date as Date
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class ConversationOut(ORMModel):
    id: str
    title: str
    created_at: datetime
    updated_at: datetime


class MessageOut(ORMModel):
    id: str
    request_id: str
    role: str
    content: str
    kind: str
    details: dict
    created_at: datetime


class WorkflowOut(ORMModel):
    id: str
    status: str
    slots: dict
    weather: dict | None
    proposal: str | None
    updated_at: datetime

    @computed_field
    @property
    def proposal_ar(self) -> str | None:
        if not self.proposal or not self.weather:
            return None
        from app.services.workflow import build_proposal

        return build_proposal(self.slots, self.weather, arabic=True)


class ConversationDetail(ConversationOut):
    messages: list[MessageOut]
    workflow: WorkflowOut | None


class SendMessage(BaseModel):
    content: str = Field(min_length=1, max_length=6000)
    request_id: UUID
    language: Literal["auto", "en", "ar"] = "auto"

    @field_validator("content")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("Message cannot be blank")
        return value.strip()


class MemoryIn(BaseModel):
    content: str = Field(min_length=1, max_length=500)

    @field_validator("content")
    @classmethod
    def clean(cls, value):
        if not value.strip():
            raise ValueError("Memory cannot be blank")
        return value.strip()


class MemoryOut(ORMModel):
    id: str
    content: str
    created_at: datetime


class Slots(BaseModel):
    model_config = ConfigDict(extra="forbid")
    city: str | None = Field(default=None, min_length=2, max_length=120)
    date: Date | None = None
    activities: str | None = Field(default=None, min_length=2, max_length=500)
    people: int | None = Field(default=None, ge=1, le=50)
    notes: str | None = Field(default=None, max_length=500)

    @field_validator("city", "activities", "notes")
    @classmethod
    def trimmed(cls, value):
        if value is not None and not value.strip():
            raise ValueError("Use a value or null to clear this field")
        return value.strip() if value is not None else None


class WorkflowAction(BaseModel):
    action: Literal["pause", "resume", "confirm", "cancel", "restart"]


class PlanOut(ORMModel):
    id: str
    workflow_id: str
    slots: dict
    weather: dict
    content: str
    created_at: datetime

    @computed_field
    @property
    def content_ar(self) -> str:
        from app.services.workflow import build_proposal

        return build_proposal(self.slots, self.weather, arabic=True).replace(
            "راجع التفاصيل ثم قل أكد الخطة لحفظها.", "تم تأكيد هذه الخطة وحفظها."
        )
