class ProviderError(Exception):
    def __init__(self, message: str, code: str = "provider_unavailable", status: int = 502):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


def public_message(code: str) -> str:
    if code == "workflow_closed":
        return "This outing is closed. Start a new conversation for another plan."
    if code in ("not_ready", "workflow_missing"):
        return "Complete your outing details and check the forecast before confirming."
    if code == "forecast_refreshed":
        return "The forecast has changed. Review the updated plan and confirm again."
    if code == "rate_limited":
        return "You’ve reached the limit for now. Please try again in a moment."
    if code in ("city_not_found", "forecast_range", "invalid_slots"):
        return "Check your city, date and outing details, then try again."
    if code.startswith("weather"):
        return "The forecast is unavailable. Your details are saved; please try again."
    if code in ("no_speech", "unclear_speech"):
        return "I couldn’t hear you clearly. Speak a little closer and try again."
    return "Sarjy is temporarily unavailable. Please try again shortly."
