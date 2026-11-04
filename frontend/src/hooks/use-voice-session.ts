"use client";

import { useEffect, useRef, useState } from "react";
import type { AudioController } from "./use-audio";
import type { Message } from "@/lib/api";
import { useLocale } from "@/lib/locale";

// Listen → transcribe → send → speak → listen. Each await checks whether the user ended the session.
export function useVoiceSession(
  audio: AudioController,
  onTurn: (text: string) => Promise<Message>,
) {
  const [active, setActive] = useState(false);
  const [thinking, setThinking] = useState(false);
  const { t } = useLocale();
  const generation = useRef(0);
  const latest = useRef({ audio, onTurn });
  latest.current = { audio, onTurn };

  function end() {
    generation.current++;
    setActive(false);
    setThinking(false);
    latest.current.audio.cancel();
  }

  useEffect(() => {
    const hidden = () => {
      if (document.hidden) end();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      generation.current++;
    };
    // The listener reads the latest controller through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    if (active) return;
    const run = ++generation.current;
    const current = () => generation.current === run;
    latest.current.audio.unlock();
    setActive(true);
    try {
      while (current()) {
        const text = await latest.current.audio.listen();
        if (!current()) break;
        setThinking(true);
        const reply = await latest.current.onTurn(text);
        setThinking(false);
        if (!current()) break;
        if (reply.kind === "error") throw new Error(reply.content);
        const played = await latest.current.audio.speak(
          reply.id,
          reply.content,
        );
        if (!current() || !played) break;
        // Let the speaker tail fade before reopening the microphone.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } catch (cause) {
      if (
        current() &&
        !(cause instanceof DOMException && cause.name === "AbortError")
      ) {
        latest.current.audio.setError(
          cause instanceof Error
            ? cause.message
            : "Voice chat stopped. Try again.",
        );
      }
    } finally {
      if (current()) {
        setActive(false);
        setThinking(false);
      }
    }
  }

  const status = audio.requesting
    ? t("Starting microphone…")
    : audio.recording
      ? t("Listening · pause when you’re done")
      : audio.transcribing
        ? t("Understanding your speech…")
        : thinking
          ? t("Sarjy is thinking…")
          : audio.preparingSpeech
            ? t("Preparing spoken reply…")
            : audio.speaking
              ? t("Sarjy is speaking…")
              : active
                ? t("Getting ready to listen…")
                : t("Speak naturally. Pause for a reply.");

  return {
    active,
    status,
    start,
    end,
  };
}
export type VoiceSession = ReturnType<typeof useVoiceSession>;
