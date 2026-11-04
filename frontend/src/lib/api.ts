export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}
export interface Message {
  id: string;
  request_id?: string;
  role: string;
  content: string;
  kind: string;
  details: Record<string, unknown>;
  created_at: string;
}
export interface OutingSlots {
  city?: string | null;
  date?: string | null;
  activities?: string | null;
  people?: number | null;
  notes?: string | null;
}
export interface Weather {
  city: string;
  country: string;
  date: string;
  high_c: number;
  low_c: number;
  rain_percent: number;
  wind_kmh: number;
  summary: string;
  source: string;
  fetched_at: string;
}
export interface Workflow {
  id: string;
  status: "collecting" | "review" | "paused" | "confirmed" | "cancelled";
  slots: OutingSlots;
  weather: Weather | null;
  proposal: string | null;
  proposal_ar?: string | null;
  updated_at: string;
}
export interface Detail extends Conversation {
  messages: Message[];
  workflow: Workflow | null;
}
export interface Memory {
  id: string;
  content: string;
  created_at: string;
}
export interface Plan {
  id: string;
  workflow_id: string;
  content_ar?: string;
  slots: OutingSlots;
  weather: Weather;
  content: string;
  created_at: string;
}
export interface Session {
  workspace_id: string;
  ai_configured: boolean;
  timezone: string;
  today: string;
  mode: string;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(
      typeof data.detail === "string"
        ? data.detail
        : "Check your details and try again.",
    );
    Object.assign(error, {
      code:
        data.code ||
        (response.status === 429 ? "rate_limited" : "request_failed"),
      status: response.status,
    });
    throw error;
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
