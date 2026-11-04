from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Conversation, Plan, Workflow, now
from app.providers.errors import ProviderError
from app.providers.weather import WeatherProvider
from app.schemas import Slots

REQUIRED = {
    "city": "Which city would you like to explore?",
    "date": "What date are you planning for? Choose today or a day in the next 15 days.",
    "activities": "What would you enjoy doing? For example: a walk, good food, museums, or a family afternoon.",
    "people": "How many people are going? Choose a number from 1 to 50.",
}


def get_workflow(db: Session, conversation: Conversation, create: bool = False) -> Workflow | None:
    workflow = db.scalar(select(Workflow).where(Workflow.conversation_id == conversation.id))
    if workflow is None and create:
        workflow = Workflow(conversation_id=conversation.id, slots={}, status="collecting")
        db.add(workflow)
        db.flush()
    return workflow


def next_question(workflow: Workflow) -> str:
    for field, question in REQUIRED.items():
        if not workflow.slots.get(field):
            return question
    return "Your details are ready. Review the forecast and confirm your plan."


def update_workflow(
    db: Session, conversation: Conversation, patch: Slots, weather: WeatherProvider
) -> Workflow:
    workflow = get_workflow(db, conversation, True)
    if workflow.status in ("confirmed", "cancelled"):
        raise ProviderError(
            "This outing is closed. Start a new outing to change the details.",
            "workflow_closed",
            409,
        )
    changes = patch.model_dump(mode="json", exclude_unset=True)
    merged = {**workflow.slots, **changes}
    day = merged.get("date")
    if day:
        today = datetime.now(ZoneInfo(get_settings().app_timezone)).date()
        # The final range is checked in the destination's timezone after geocoding.
        if (
            not today - timedelta(days=1)
            <= datetime.fromisoformat(day).date()
            <= today + timedelta(days=16)
        ):
            raise ProviderError(
                "Choose a date within the next 15 days. Forecasts beyond that are unavailable.",
                "forecast_range",
                422,
            )
    workflow.slots = merged
    workflow.weather = None
    workflow.proposal = None
    workflow.status = "collecting"
    conversation.updated_at = now()
    workflow.updated_at = now()
    # Persist edits even if the external weather call fails. Never retain a stale proposal.
    db.flush()
    if all(merged.get(field) for field in REQUIRED):
        forecast = weather.forecast(merged["city"], datetime.fromisoformat(day).date())
        workflow.weather = forecast
        workflow.proposal = build_proposal(merged, forecast)
        workflow.status = "review"
        db.flush()
    return workflow


def build_proposal(slots: dict, weather: dict, arabic: bool = False) -> str:
    risky = weather["rain_percent"] >= 50 or weather["wind_kmh"] >= 40 or weather["code"] >= 95
    hot = weather["high_c"] >= 32
    cold = weather["low_c"] <= 5
    guidance = (
        "Make an indoor activity your main stop, with an outdoor option only if conditions improve."
        if risky
        else "Keep outdoor time to the cooler morning or evening, bring water, and take an indoor break during peak heat."
        if hot
        else "Plan a short outdoor stop with warm layers and an indoor place to warm up."
        if cold
        else "Start with an outdoor activity, then take a relaxed break indoors."
    )
    if arabic:
        advice = (
            "اجعل النشاط الرئيسي داخل مكان مغلق، والخروج مشروط بتحسن الطقس."
            if risky
            else "اختر الصباح أو المساء للخروج، واشرب الماء وخذ استراحة في مكان مغلق وقت الحر."
            if hot
            else "اجعل الخروج قصيرا مع ملابس دافئة واستراحة في مكان مغلق."
            if cold
            else "ابدأ بنشاط خارجي ثم خذ استراحة في مكان مغلق."
        )
        return (
            f"نزهتك في {weather['city']} بتاريخ {slots['date']} لعدد {slots['people']} أشخاص. "
            f"الحرارة بين {weather['low_c']:g} و{weather['high_c']:g} درجة مئوية، واحتمال المطر {weather['rain_percent']:g} بالمئة. "
            f"الأنشطة المفضلة: {slots['activities']}. {advice} "
            "تحقق من مواعيد الأماكن قبل الخروج. لم يتم إجراء أي حجز. راجع التفاصيل ثم قل أكد الخطة لحفظها."
        )
    notes = f"\nYour notes: {slots['notes']}" if slots.get("notes") else ""
    return (
        f"Your outing in {weather['city']}, {weather['country']} on {slots['date']} for {slots['people']} people.\n\n"
        f"Forecast: {weather['summary']}, {weather['low_c']:g}–{weather['high_c']:g}°C, "
        f"{weather['rain_percent']:g}% chance of rain, wind up to {weather['wind_kmh']:g} km/h.\n\n"
        f"Your interests: {slots['activities']}. {guidance}\n\n"
        "Suggested rhythm: start with your preferred activity, take a food or coffee break, then leave a flexible final stop. "
        "Choose actual venues and check opening hours before leaving. This is a forecast-based outline; no reservations have been made."
        f"{notes}\n\nReview these details, make any corrections, and select Confirm plan to save."
    )


def act_on_workflow(
    db: Session, conversation: Conversation, action: str, weather: WeatherProvider
) -> Workflow:
    workflow = get_workflow(db, conversation, action == "restart")
    if workflow is None:
        raise ProviderError("Start an outing first.", "workflow_missing", 409)
    if action == "restart":
        # A confirmed workflow has an immutable saved plan; a new conversation starts a new one.
        if workflow.status == "confirmed":
            raise ProviderError(
                "Your saved plan is kept. Start a new conversation for another outing.",
                "workflow_closed",
                409,
            )
        workflow.status, workflow.slots, workflow.weather, workflow.proposal = (
            "collecting",
            {},
            None,
            None,
        )
    elif action == "confirm":
        if workflow.status == "confirmed":
            return workflow  # Idempotent confirmation.
        if workflow.status != "review" or not workflow.weather or not workflow.proposal:
            raise ProviderError(
                "Complete your outing details and fetch the forecast before confirming.",
                "not_ready",
                409,
            )
        destination_today = datetime.now(
            ZoneInfo(workflow.weather.get("timezone", get_settings().app_timezone))
        ).date()
        if datetime.fromisoformat(workflow.slots["date"]).date() < destination_today:
            raise ProviderError(
                "That outing date has passed. Choose a new date and refresh the forecast.",
                "forecast_range",
                422,
            )
        fetched = datetime.fromisoformat(workflow.weather["fetched_at"])
        if datetime.now(UTC) - fetched > timedelta(minutes=30):
            update_workflow(db, conversation, Slots(), weather)
            raise ProviderError(
                "The forecast was refreshed. Review the updated plan and confirm again.",
                "forecast_refreshed",
                409,
            )
        db.add(
            Plan(
                workspace_id=conversation.workspace_id,
                workflow_id=workflow.id,
                slots=workflow.slots.copy(),
                weather=workflow.weather.copy(),
                content=workflow.proposal,
            )
        )
        workflow.status = "confirmed"
    elif action == "cancel":
        if workflow.status == "confirmed":
            raise ProviderError(
                "This plan is already saved. Delete the conversation to remove it.",
                "workflow_closed",
                409,
            )
        workflow.status = "cancelled"
    elif action == "pause":
        if workflow.status in ("confirmed", "cancelled"):
            raise ProviderError("This outing is already closed.", "workflow_closed", 409)
        workflow.status = "paused"
    elif action == "resume":
        if workflow.status in ("confirmed", "cancelled"):
            raise ProviderError("This outing is already closed.", "workflow_closed", 409)
        return update_workflow(db, conversation, Slots(), weather)
    conversation.updated_at = now()
    workflow.updated_at = now()
    db.flush()
    return workflow
