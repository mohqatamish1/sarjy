import { Square } from "lucide-react";
import type { VoiceSession } from "@/hooks/use-voice-session";
import { useLocale } from "@/lib/locale";

export function VoiceControls({ voice }: { voice: VoiceSession }) {
  const { t } = useLocale();
  if (!voice.active) return null;
  return (
    <section
      className="voice-controls voice-active"
      aria-label={t("Voice chat controls")}
    >
      <div className="voice-session-status">
        <span role="status">{voice.status}</span>
        <button type="button" className="end-voice" onClick={voice.end}>
          <Square size={14} fill="currentColor" />
          {t("End voice chat")}
        </button>
      </div>
    </section>
  );
}
