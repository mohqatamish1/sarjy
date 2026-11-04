import { useLocale } from "@/lib/locale";
import type { RefObject } from "react";
import {
  ArrowUp,
  AudioLines,
  Brain,
  CalendarCheck,
  ChevronRight,
  Mic,
  Sparkles,
  Square,
  Trash2,
  Volume2,
} from "lucide-react";
import type { Detail, Session } from "@/lib/api";
import type { AudioController } from "@/hooks/use-audio";
import type { VoiceSession } from "@/hooks/use-voice-session";
import { friendlyError } from "@/lib/errors";
import { VoiceControls } from "./voice-controls";

type Props = {
  detail: Detail;
  session: Session;
  audio: AudioController;
  voice: VoiceSession;
  busy: boolean;
  locked: boolean;
  draft: string;
  setDraft: (draft: string) => void;
  bottom: RefObject<HTMLDivElement | null>;
  composer: RefObject<HTMLTextAreaElement | null>;
  onSend: () => Promise<unknown>;
  onDelete: () => Promise<void>;
  onRetry: (index: number) => void;
  onOpenPlanner: () => void;
  onOpenMemory: () => void;
};

// Displays the conversation; Assistant owns requests, useAudio owns the microphone.
export function ConversationView({
  detail,
  session,
  audio,
  voice,
  busy,
  locked,
  draft,
  setDraft,
  bottom,
  composer,
  onSend,
  onDelete,
  onRetry,
  onOpenPlanner,
  onOpenMemory,
}: Props) {
  const { t, locale } = useLocale();
  return (
    <>
      <div className="conversation-scroll">
        {detail.messages.length === 0 ? (
          <div className="welcome">
            <div className="welcome-orb" aria-hidden="true">
              <div className="orb-core">
                <AudioLines size={39} strokeWidth={1.6} />
              </div>
              <span />
              <span />
            </div>
            <p className="welcome-intro">
              {t("A moment to think. A voice to help.")}
            </p>
            <h1>{t("What’s on your mind?")}</h1>
            <p className="welcome-description">
              {t("Talk it through, find an answer, or make a plan.")}
              <br />
              {t("I’m here for the everyday and the unexpected.")}
            </p>
            <button
              className="talk-button"
              disabled={busy || voice.active || !session.ai_configured}
              onClick={() => void voice.start()}
            >
              <Mic size={19} />
              {voice.active ? t("Voice chat active") : t("Let’s talk")}
            </button>
            <p className="voice-caption">
              {voice.active
                ? t("Your voice chat controls are below.")
                : t("Speak, pause, and hear a reply. No send button needed.")}
            </p>
            <div className="suggestions">
              <button disabled={locked} onClick={onOpenPlanner}>
                <span className="suggestion-icon peach">
                  <CalendarCheck size={19} />
                </span>
                <strong>{t("Plan a day out")}</strong>
                <span>{t("A little adventure, weather included")}</span>
                <ChevronRight size={16} />
              </button>
              <button
                disabled={locked}
                onClick={() => {
                  setDraft(t("Help me think through an idea"));
                  composer.current?.focus();
                }}
              >
                <span className="suggestion-icon lavender">
                  <Sparkles size={19} />
                </span>
                <strong>{t("Think out loud")}</strong>
                <span>{t("Find a fresh angle on an idea")}</span>
                <ChevronRight size={16} />
              </button>
              <button disabled={locked} onClick={onOpenMemory}>
                <span className="suggestion-icon mint">
                  <Brain size={19} />
                </span>
                <strong>{t("Make it personal")}</strong>
                <span>{t("Tell me a little about you")}</span>
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        ) : (
          <div
            className="message-list"
            role="log"
            aria-label={t("Conversation messages")}
            aria-live="polite"
          >
            {detail.messages.map((item, index) => (
              <article
                key={item.id}
                className={`message message-${item.role} ${item.kind === "error" ? "message-error" : ""}`}
              >
                <span
                  className={`message-avatar ${item.role === "assistant" ? "assistant-avatar" : ""}`}
                >
                  {item.role === "assistant" ? <AudioLines size={17} /> : "Y"}
                </span>
                <div className="message-body">
                  <div className="message-heading">
                    <strong>
                      {item.role === "assistant" ? t("Sarjy") : t("You")}
                    </strong>
                    <time>
                      {new Intl.DateTimeFormat(locale, {
                        hour: "numeric",
                        minute: "2-digit",
                        timeZone: session.timezone,
                      }).format(new Date(item.created_at))}
                    </time>
                    {item.kind === "workflow" && (
                      <span className="message-tag">{t("Outing planner")}</span>
                    )}
                  </div>
                  <p dir="auto">
                    {item.kind === "error"
                      ? t(friendlyError(item.details.code))
                      : item.content}
                  </p>
                  {item.kind === "error" &&
                    index === detail.messages.length - 1 && (
                      <button
                        className="text-button"
                        disabled={locked}
                        onClick={() => onRetry(index)}
                      >
                        {t("Retry")}
                      </button>
                    )}
                  {item.role === "assistant" && item.kind !== "error" && (
                    <button
                      className="read-aloud"
                      aria-label={
                        audio.speaking === item.id
                          ? t("Stop reading")
                          : t("Read aloud")
                      }
                      onClick={() => {
                        if (audio.speaking !== item.id) audio.unlock();
                        void audio.speak(item.id, item.content);
                      }}
                    >
                      {audio.speaking === item.id ? (
                        <Square size={13} />
                      ) : (
                        <Volume2 size={14} />
                      )}
                      {audio.speaking === item.id
                        ? t("Stop reading")
                        : t("Read aloud")}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        {busy && (
          <div className="thinking" role="status">
            <span className="typing-dots">
              <i />
              <i />
              <i />
            </span>
            {t("Sarjy is thinking…")}
          </div>
        )}
        <div ref={bottom} />
      </div>
      <div className="composer-area">
        <VoiceControls voice={voice} />
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void onSend();
          }}
        >
          <textarea
            ref={composer}
            aria-label={t("Message Sarjy")}
            placeholder={
              audio.recording
                ? t("Listening to you…")
                : t("Ask anything, or tell me about your day…")
            }
            value={draft}
            maxLength={6000}
            rows={2}
            disabled={
              busy ||
              voice.active ||
              audio.transcribing ||
              audio.recording ||
              audio.requesting
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void onSend();
              }
            }}
          />
          <div className="composer-toolbar">
            <div>
              <button
                type="button"
                className="icon-button mic-control"
                aria-label={t("Start voice chat")}
                disabled={busy || voice.active || !session.ai_configured}
                onClick={() => void voice.start()}
              >
                <Mic size={19} />
              </button>
              <span>
                {voice.active
                  ? voice.status
                  : t("Talk to Sarjy, or type a message.")}
              </span>
            </div>
            <button
              className="send-button"
              aria-label={t("Send message")}
              type="submit"
              disabled={locked || !draft.trim()}
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </form>
        <div className="composer-footnote">
          <span>
            {t("Sarjy can make mistakes. Double-check important details.")}
          </span>
          <button
            onClick={onDelete}
            disabled={locked}
            aria-label={t("Delete conversation")}
          >
            <Trash2 size={12} />
            {t("Clear conversation")}
          </button>
        </div>
      </div>
    </>
  );
}
