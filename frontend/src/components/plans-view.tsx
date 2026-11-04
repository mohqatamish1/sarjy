import { useLocale } from "@/lib/locale";
import { CalendarCheck, Sparkles } from "lucide-react";
import type { Plan } from "@/lib/api";

type Props = { plans: Plan[]; onOpenPlanner: () => void };

export function PlansView({ plans, onOpenPlanner }: Props) {
  const { t, locale } = useLocale();
  return (
    <div className="collection-view">
      <span className="page-symbol">
        <CalendarCheck size={25} />
      </span>
      <h1>{t("Good days, in the making.")}</h1>
      <p className="collection-intro">
        {t(
          "Your confirmed outings, with the forecast and details you reviewed.",
        )}
      </p>
      {plans.length ? (
        <div className="plan-list">
          {plans.map((plan) => (
            <article key={plan.id}>
              <div className="plan-heading">
                <CalendarCheck size={20} />
                <h2>{plan.weather.city}</h2>
                <span>{plan.slots.date}</span>
              </div>
              <p className="plan-interests" dir="auto">
                {plan.slots.activities}
              </p>
              <details>
                <summary>{t("View saved outline")}</summary>
                <p dir="auto">
                  {locale === "ar"
                    ? plan.content_ar || plan.content
                    : plan.content}
                </p>
              </details>
              <small>
                {t("Forecast saved")}{" "}
                {new Date(plan.weather.fetched_at).toLocaleString(locale)}
                {t(". Conditions may change.")}
              </small>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-plans">
          <CloudIllustration />
          <h2>{t("Leave room for a little adventure.")}</h2>
          <p>
            {t("Plan an outing, review the weather, and confirm it.")}
            <br />
            {t("You’ll find it waiting here.")}
          </p>
          <button className="primary" onClick={onOpenPlanner}>
            {t("Plan an outing")}
          </button>
        </div>
      )}
    </div>
  );
}

function CloudIllustration() {
  return (
    <div className="empty-plan-art" aria-hidden="true">
      <CalendarCheck size={55} strokeWidth={1} />
      <Sparkles size={23} strokeWidth={1.4} />
    </div>
  );
}
