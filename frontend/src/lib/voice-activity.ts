// Energy gate for turn boundaries. It is deliberately independent of the UI and recorder.
export class VoiceActivity {
  elapsedMs = 0;
  voicedMs = 0;
  lastVoiceMs = 0;
  level = 0;

  get heardSpeech() {
    return this.voicedMs >= 180;
  }

  push(
    samples: Float32Array,
    sampleRate: number,
  ): "listen" | "finish" | "silent" {
    const durationMs = (samples.length / sampleRate) * 1000;
    this.elapsedMs += durationMs;
    this.level = Math.sqrt(
      samples.reduce((sum, x) => sum + x * x, 0) / samples.length,
    );
    if (this.level >= 0.012) {
      this.voicedMs += durationMs;
      this.lastVoiceMs = this.elapsedMs;
    }
    const heardSpeech = this.heardSpeech;
    if (heardSpeech && this.elapsedMs - this.lastVoiceMs >= 1300)
      return "finish";
    if (this.elapsedMs >= 60000) return heardSpeech ? "finish" : "silent";
    if (!heardSpeech && this.elapsedMs >= 10000) return "silent";
    return "listen";
  }
}

export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const samples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const sample of chunk) {
      const x = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, x < 0 ? x * 32768 : x * 32767, true);
      offset += 2;
    }
  return new Blob([buffer], { type: "audio/wav" });
}
