import { encodeWav, VoiceActivity } from "./voice-activity";

export async function recordUtterance(options: {
  signal: AbortSignal;
  ready: () => void;
}): Promise<Blob> {
  const { signal } = options;
  if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
    throw new Error(
      "Voice chat needs a supported browser on HTTPS or localhost.",
    );
  }
  const context = new AudioContext({ sampleRate: 16000 });
  let stream: MediaStream | null = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    signal.throwIfAborted();
    await context.resume();
    await context.audioWorklet.addModule("/voice-capture.js");
    signal.throwIfAborted();
    options.ready();
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, "voice-capture", {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    // A connected, silent output keeps the worklet processing on all supported browsers.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(capture).connect(mute).connect(context.destination);
    return await new Promise<Blob>((resolve, reject) => {
      const gate = new VoiceActivity();
      const chunks: Float32Array[] = [];
      const preRoll: Float32Array[] = [];
      let started = false;
      const cleanup = () => {
        clearTimeout(limit);
        clearTimeout(noFrames);
        capture.port.onmessage = null;
        capture.onprocessorerror = null;
        signal.removeEventListener("abort", abort);
        stream
          ?.getTracks()
          .forEach((track) => track.removeEventListener("ended", disconnected));
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      const abort = () =>
        fail(new DOMException("Voice chat ended", "AbortError"));
      const disconnected = () =>
        fail(
          new Error(
            "The microphone disconnected. Reconnect it and start voice chat again.",
          ),
        );
      const limit = setTimeout(
        () =>
          fail(new Error("The recording timed out. Start voice chat again.")),
        65000,
      );
      const noFrames = setTimeout(
        () =>
          fail(
            new Error(
              "No microphone audio arrived. Check your system microphone and try again.",
            ),
          ),
        10000,
      );
      stream
        ?.getTracks()
        .forEach((track) =>
          track.addEventListener("ended", disconnected, { once: true }),
        );
      capture.onprocessorerror = () =>
        fail(new Error("Audio capture failed. Start voice chat again."));
      signal.addEventListener("abort", abort, { once: true });
      capture.port.onmessage = ({ data }: MessageEvent<Float32Array>) => {
        if (signal.aborted) return;
        clearTimeout(noFrames);
        const result = gate.push(data, context.sampleRate);
        if (!started) {
          preRoll.push(data);
          if (preRoll.length > 5) preRoll.shift();
          if (gate.heardSpeech) {
            chunks.push(...preRoll);
            started = true;
          }
        } else chunks.push(data);
        if (result === "listen") return;
        cleanup();
        if (result === "silent")
          reject(
            new Error(
              "No speech was detected. Speak a little closer and try again.",
            ),
          );
        else resolve(encodeWav(chunks, context.sampleRate));
      };
      if (signal.aborted) abort();
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "NotAllowedError") {
      throw new Error(
        "Microphone access was denied. Allow it in your browser's site settings, or type your message below.",
      );
    }
    if (
      cause instanceof DOMException &&
      ["NotFoundError", "OverconstrainedError"].includes(cause.name)
    ) {
      throw new Error(
        "The microphone is unavailable. Check your system microphone and try again.",
      );
    }
    throw cause;
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    await context.close();
  }
}
