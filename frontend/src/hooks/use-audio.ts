"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { recordUtterance } from "@/lib/record-utterance";
import { SpeechPlayer } from "@/lib/speech-output";

// One-turn audio lifecycle. useVoiceSession decides when the next turn starts.
export function useAudio() {
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [preparingSpeech, setPreparingSpeech] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<AbortController | null>(null);
  const player = useRef<SpeechPlayer | null>(null);
  const mounted = useRef(true);

  function cancel() {
    operation.current?.abort();
    operation.current = null;
    window.speechSynthesis?.cancel();
    setRecording(false);
    setTranscribing(false);
    setRequesting(false);
    setSpeaking(null);
    setPreparingSpeech(false);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operation.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  function unlock() {
    player.current ??= new SpeechPlayer();
    player.current.unlock();
  }

  async function listen(): Promise<string> {
    cancel();
    setError(null);
    setRequesting(true);
    const controller = new AbortController();
    operation.current = controller;
    try {
      const blob = await recordUtterance({
        signal: controller.signal,
        ready: () => {
          if (mounted.current) {
            setRequesting(false);
            setRecording(true);
          }
        },
      });
      controller.signal.throwIfAborted();
      setRecording(false);
      setTranscribing(true);
      const data = new FormData();
      data.append("file", blob, "utterance.wav");
      data.append("language", "auto");
      const result = await api<{ text: string }>("/transcriptions", {
        method: "POST",
        body: data,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      return result.text;
    } finally {
      if (mounted.current && operation.current === controller) {
        setRequesting(false);
        setRecording(false);
        setTranscribing(false);
      }
    }
  }

  async function speak(id: string, text: string): Promise<boolean> {
    if (speaking === id) {
      cancel();
      return false;
    }
    cancel();
    setError(null);
    const controller = new AbortController();
    operation.current = controller;
    setSpeaking(id);
    setPreparingSpeech(true);
    player.current ??= new SpeechPlayer();
    try {
      await player.current.speak(id, text, controller.signal, (value) => {
        if (mounted.current && operation.current === controller)
          setPreparingSpeech(value);
      });
      return !controller.signal.aborted;
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current)
        setError(
          cause instanceof Error ? cause.message : "Speech playback failed.",
        );
      return false;
    } finally {
      if (mounted.current && operation.current === controller) {
        setSpeaking(null);
        setPreparingSpeech(false);
      }
    }
  }

  return {
    recording,
    requesting,
    transcribing,
    speaking,
    preparingSpeech,
    error,
    setError,
    listen,
    speak,
    cancel,
    unlock,
  };
}
export type AudioController = ReturnType<typeof useAudio>;
