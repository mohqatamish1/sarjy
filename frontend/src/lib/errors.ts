// Provider diagnostics stay on the server. UI copy describes the next useful action.
export function friendlyError(cause: unknown): string {
  const known = [
    "This outing is closed. Start a new conversation for another plan.",
    "Complete your outing details and check the forecast before confirming.",
    "The forecast has changed. Review the updated plan and confirm again.",
    "The connection was interrupted. Please try again.",
    "Sarjy is temporarily unavailable. Please try again shortly.",
    "The forecast is unavailable. Your details are saved; please try again.",
    "Check your city, date and outing details, then try again.",
    "You’ve reached the limit for now. Please try again in a moment.",
  ];
  if (typeof cause === "string" && known.includes(cause)) return cause;
  const code =
    typeof cause === "object" && cause && "code" in cause
      ? String(cause.code)
      : String(cause || "");
  if (code === "workflow_closed")
    return "This outing is closed. Start a new conversation for another plan.";
  if (/not_ready|workflow_missing/.test(code))
    return "Complete your outing details and check the forecast before confirming.";
  if (code === "forecast_refreshed")
    return "The forecast has changed. Review the updated plan and confirm again.";
  if (/rate_limited|429/.test(code))
    return "You’ve reached the limit for now. Please try again in a moment.";
  if (/invalid_slots|forecast_range|city_not_found/.test(code))
    return "Check your city, date and outing details, then try again.";
  if (/weather|forecast/.test(code))
    return "The forecast is unavailable. Your details are saved; please try again.";
  if (/no_speech|unclear_speech|No speech|Speech wasn't clear/.test(code))
    return "I couldn’t hear you clearly. Speak a little closer and try again.";
  if (/denied|NotAllowedError/.test(code))
    return "Microphone access was denied. Allow it in your browser’s site settings, or type below.";
  if (/microphone|audio capture|Audio capture/i.test(code))
    return "I couldn’t hear your microphone. Check your system microphone and try again.";
  if (/speech|Speech|playback|audio.*play/i.test(code))
    return "I couldn’t play the reply. Try Read aloud, or read the message below.";
  if (/credentials|model_|provider_unavailable/.test(code))
    return "Sarjy is temporarily unavailable. Please try again shortly.";
  return "The connection was interrupted. Please try again.";
}
