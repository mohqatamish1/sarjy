import { encodeWav } from "./voice-activity";

function abortError() {
  return new DOMException("Voice chat ended", "AbortError");
}

async function browserSpeech(text: string, signal: AbortSignal): Promise<void> {
  if (!("speechSynthesis" in window))
    throw new Error("No browser speech voice is available.");
  const synth = window.speechSynthesis;
  if (!synth.getVoices().length)
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        synth.removeEventListener("voiceschanged", done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      synth.addEventListener("voiceschanged", done, { once: true });
    });
  signal.throwIfAborted();
  const language = /[\u0600-\u06ff]/.test(text) ? "ar" : "en";
  const voice = synth
    .getVoices()
    .find((v) => v.lang.toLowerCase().startsWith(language));
  if (!voice)
    throw new Error(
      `No ${language === "ar" ? "Arabic" : "English"} browser voice is installed.`,
    );
  await new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    const abort = () => {
      cleanup();
      synth.cancel();
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      synth.cancel();
      cleanup();
      reject(
        new Error("Speech playback timed out. Select Read aloud to try again."),
      );
    }, 120000);
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    };
    utterance.onend = () => {
      cleanup();
      resolve();
    };
    utterance.onerror = () => {
      cleanup();
      reject(
        new Error("Speech playback failed. Select Read aloud to try again."),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else synth.speak(utterance);
  });
}

// Reuse one media element: the initial user gesture unlocks later reply playback on mobile.
export class SpeechPlayer {
  private player: HTMLAudioElement | null = null;

  unlock() {
    this.player ??= new Audio();
    const url = URL.createObjectURL(encodeWav([new Float32Array(160)], 16000));
    this.player.src = url;
    void this.player
      .play()
      .catch(() => undefined)
      .finally(() => URL.revokeObjectURL(url));
  }

  private async play(blob: Blob, signal: AbortSignal): Promise<void> {
    const player = (this.player ??= new Audio());
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          player.pause();
          reject(
            new Error(
              "Audio playback timed out. Select Read aloud to try again.",
            ),
          );
        }, 60000);
        const cleanup = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          player.onended = null;
          player.onerror = null;
        };
        const abort = () => {
          cleanup();
          player.pause();
          player.removeAttribute("src");
          reject(abortError());
        };
        player.onended = () => {
          cleanup();
          resolve();
        };
        player.onerror = () => {
          cleanup();
          reject(new Error("Reply audio could not be played."));
        };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
          return;
        }
        player.src = url;
        void player.play().catch(() => {
          cleanup();
          reject(
            new Error(
              "Audio playback was blocked. Select Read aloud to enable it.",
            ),
          );
        });
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async speak(
    id: string,
    text: string,
    signal: AbortSignal,
    preparing: (value: boolean) => void,
  ) {
    let parts = 1;
    for (let part = 0; part < parts; part++) {
      signal.throwIfAborted();
      preparing(true);
      let blob: Blob;
      try {
        const response = await fetch(
          `/api/messages/${id}/speech?part=${part}`,
          {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            signal,
          },
        );
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error.detail || "Reply speech is unavailable.");
        }
        parts = Number(response.headers.get("x-speech-parts") || 1);
        if (!Number.isInteger(parts) || parts < 1 || parts > 100)
          throw new Error("Invalid speech response.");
        blob = await response.blob();
      } catch (cause) {
        if (signal.aborted) throw abortError();
        if (part > 0) throw cause;
        // A matching installed browser voice is the fallback; never pretend an absent voice worked.
        preparing(false);
        try {
          await browserSpeech(text, signal);
          return;
        } catch (fallback) {
          if (signal.aborted) throw abortError();
          throw new Error(
            `${cause instanceof Error ? cause.message : "Groq speech is unavailable."} ${fallback instanceof Error ? fallback.message : ""}`,
          );
        }
      }
      preparing(false);
      await this.play(blob, signal);
    }
  }
}
