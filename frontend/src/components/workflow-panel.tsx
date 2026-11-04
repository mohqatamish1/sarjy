"use client";

import { useLocale } from "@/lib/locale";

import { useEffect, useState } from "react";
import {
  Check,
  CloudSun,
  MapPin,
  Pause,
  Play,
  RefreshCw,
  X,
} from "lucide-react";
import { friendlyError } from "@/lib/errors";
import { api, OutingSlots, Workflow } from "@/lib/api";

export function WorkflowPanel({
  conversationId,
  workflow,
  changed,
  fail,
  today,
}: {
  conversationId: string;
  workflow: Workflow | null;
  changed: () => Promise<void>;
  fail: (message: string) => void;
  today: string;
}) {
  const { t, locale } = useLocale();
  const [slots, setSlots] = useState<OutingSlots>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSlots(workflow?.slots || {});
  }, [workflow]);
  const closed =
    workflow?.status === "confirmed" || workflow?.status === "cancelled";
  const paused = workflow?.status === "paused";
  const dirty = JSON.stringify(slots) !== JSON.stringify(workflow?.slots || {});
  async function perform(task: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await task();
      await changed();
    } catch (cause) {
      const message = friendlyError(cause);
      setError(message);
      fail(message);
      // Preserve the visible error if the connection is also unavailable during refresh.
      await changed().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }
  function action(action: string) {
    return perform(() =>
      api(`/conversations/${conversationId}/workflow/actions`, {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    );
  }
  const maxDate = new Date(`${today}T12:00:00Z`);
  maxDate.setUTCDate(maxDate.getUTCDate() + 15);

  return (
    <section className="outing-panel" aria-label={t("Outing planner")}>
      <div className="section-title">
        <span className="icon-tile">
          <MapPin size={18} />
        </span>
        <div>
          <h2>{t("Make a little plan")}</h2>
          <p>{t("A good day starts with the weather.")}</p>
        </div>
      </div>
      {error && (
        <p
          className="planner-error"
          role="alert"
          aria-label={t("Outing error")}
        >
          {t(friendlyError(error))}
        </p>
      )}
      {!workflow ? (
        <>
          <div className="outing-illustration" aria-hidden="true">
            <CloudSun size={50} strokeWidth={1.2} />
            <span className="illustration-line" />
            <MapPin size={25} strokeWidth={1.5} />
          </div>
          <p className="muted">
            {t(
              "A walk, a food stop, or something new. Let’s put an outing together.",
            )}
          </p>
          <button
            className="primary wide"
            disabled={busy}
            onClick={() =>
              perform(() =>
                api(`/conversations/${conversationId}/workflow`, {
                  method: "POST",
                }),
              )
            }
          >
            {t("Plan an outing")}
          </button>
        </>
      ) : (
        <>
          <div className={`workflow-status status-${workflow.status}`}>
            <span />
            {
              {
                collecting: t("Let's fill in the details"),
                review: t("Ready for your review"),
                paused: t("Paused · your details are saved"),
                confirmed: t("Confirmed and saved"),
                cancelled: t("Outing cancelled"),
              }[workflow.status]
            }
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              perform(() =>
                api(`/conversations/${conversationId}/workflow`, {
                  method: "PATCH",
                  body: JSON.stringify(slots),
                }),
              );
            }}
          >
            <fieldset disabled={busy || closed || paused}>
              <label htmlFor="outing-city">{t("City")}</label>
              <input
                id="outing-city"
                value={slots.city || ""}
                placeholder={t("e.g. Riyadh")}
                maxLength={120}
                required
                minLength={2}
                onChange={(e) =>
                  setSlots({ ...slots, city: e.target.value || null })
                }
              />
              <div className="field-pair">
                <div>
                  <label htmlFor="outing-date">{t("Date")}</label>
                  <input
                    id="outing-date"
                    type="date"
                    min={today}
                    max={maxDate.toISOString().slice(0, 10)}
                    value={slots.date || ""}
                    required
                    onChange={(e) =>
                      setSlots({ ...slots, date: e.target.value || null })
                    }
                  />
                </div>
                <div>
                  <label htmlFor="outing-people">{t("People")}</label>
                  <input
                    id="outing-people"
                    type="number"
                    min={1}
                    max={50}
                    placeholder="2"
                    required
                    value={slots.people ?? ""}
                    onChange={(e) =>
                      setSlots({
                        ...slots,
                        people: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
              </div>
              <label htmlFor="outing-activities">
                {t("What sounds good?")}
              </label>
              <input
                id="outing-activities"
                value={slots.activities || ""}
                placeholder={t("Coffee, a walk, art…")}
                required
                minLength={2}
                maxLength={500}
                onChange={(e) =>
                  setSlots({ ...slots, activities: e.target.value || null })
                }
              />
              <label htmlFor="outing-notes">
                {t("Anything else?")}
                <span className="muted">{t("Optional")}</span>
              </label>
              <textarea
                id="outing-notes"
                rows={2}
                value={slots.notes || ""}
                placeholder={t("Budget, access needs, time of day…")}
                maxLength={500}
                onChange={(e) =>
                  setSlots({ ...slots, notes: e.target.value || null })
                }
              />
              <button className="primary wide" type="submit" disabled={busy}>
                {busy
                  ? t("Checking the forecast…")
                  : workflow.status === "review"
                    ? t("Update details & forecast")
                    : t("Check weather & build plan")}
              </button>
              {workflow.status === "collecting" && (
                <button
                  className="text-button save-progress"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    perform(() =>
                      api(`/conversations/${conversationId}/workflow`, {
                        method: "PATCH",
                        body: JSON.stringify(slots),
                      }),
                    )
                  }
                >
                  {t("Save progress")}
                </button>
              )}
            </fieldset>
          </form>
          {workflow.weather && (
            <div className="weather-card">
              <div>
                <CloudSun size={25} />
                <strong>
                  {workflow.weather.high_c}°
                  <span> / {workflow.weather.low_c}°</span>
                </strong>
              </div>
              <p>
                {t(workflow.weather.summary)} {t("in")} {workflow.weather.city}
              </p>
              <small>
                {workflow.weather.rain_percent}
                {t("% rain ·")} {workflow.weather.wind_kmh}
                {t("km/h wind")}
              </small>
              <a
                href="https://open-meteo.com/"
                target="_blank"
                rel="noreferrer"
              >
                {t("Open-Meteo forecast")}
              </a>
            </div>
          )}
          {workflow.proposal && (
            <details className="proposal" open>
              <summary>
                {closed ? t("Your saved outline") : t("Your outing outline")}
              </summary>
              <p dir="auto">
                {locale === "ar"
                  ? workflow.proposal_ar || workflow.proposal
                  : workflow.proposal}
              </p>
            </details>
          )}
          {workflow.status === "review" && (
            <button
              className="confirm wide"
              disabled={busy || dirty}
              onClick={() => action("confirm")}
            >
              <Check size={16} />
              {t("Confirm plan")}
            </button>
          )}
          {dirty && workflow.status === "review" && (
            <p className="small muted">
              {t("Update the forecast after editing, then confirm.")}
            </p>
          )}
          {!closed && (
            <div className="workflow-actions">
              <button
                className="text-button"
                disabled={busy}
                onClick={() => action(paused ? "resume" : "pause")}
              >
                {paused ? <Play size={14} /> : <Pause size={14} />}
                {paused ? t("Resume outing") : t("Pause outing")}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() => action("cancel")}
              >
                <X size={14} />
                {t("Cancel")}
              </button>
            </div>
          )}
          {workflow.status === "cancelled" && (
            <button
              className="secondary wide"
              disabled={busy}
              onClick={() => action("restart")}
            >
              <RefreshCw size={15} />
              {t("Start again")}
            </button>
          )}
        </>
      )}
    </section>
  );
}
