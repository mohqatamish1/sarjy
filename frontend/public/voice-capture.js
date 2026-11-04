// The audio thread sends ~64 ms PCM frames. It never plays microphone audio.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(1024);
    this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (input)
      for (const sample of input) {
        this.frame[this.offset++] = sample;
        if (this.offset === this.frame.length) {
          this.port.postMessage(this.frame, [this.frame.buffer]);
          this.frame = new Float32Array(1024);
          this.offset = 0;
        }
      }
    return true;
  }
}
registerProcessor("voice-capture", VoiceCapture);
