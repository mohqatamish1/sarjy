import { test } from "node:test";
import assert from "node:assert/strict";
import { VoiceActivity, encodeWav } from "../src/lib/voice-activity.ts";
const rate = 16000;
const frame = (amplitude = 0) => new Float32Array(800).fill(amplitude);

test("initial silence times out without becoming a turn", () => {
  const gate = new VoiceActivity();
  for (let i = 0; i < 199; i++)
    assert.equal(gate.push(frame(), rate), "listen");
  assert.equal(gate.push(frame(), rate), "silent");
});
test("speech ends after 1.3 seconds of silence", () => {
  const gate = new VoiceActivity();
  for (let i = 0; i < 8; i++)
    assert.equal(gate.push(frame(0.1), rate), "listen");
  for (let i = 0; i < 25; i++) assert.equal(gate.push(frame(), rate), "listen");
  assert.equal(gate.push(frame(), rate), "finish");
});
test("a brief spoken answer can finish without manual sending", () => {
  const gate = new VoiceActivity();
  for (let i = 0; i < 4; i++) gate.push(frame(0.1), rate);
  for (let i = 0; i < 25; i++) assert.equal(gate.push(frame(), rate), "listen");
  assert.equal(gate.push(frame(), rate), "finish");
});
test("short noise and quiet background do not trigger a speech turn", () => {
  const gate = new VoiceActivity();
  gate.push(frame(0.08), rate);
  for (let i = 0; i < 198; i++)
    assert.equal(gate.push(frame(0.002), rate), "listen");
  assert.equal(gate.push(frame(), rate), "silent");
});
test("a pause inside a sentence does not end the turn", () => {
  const gate = new VoiceActivity();
  for (let i = 0; i < 8; i++) gate.push(frame(0.1), rate);
  for (let i = 0; i < 15; i++) assert.equal(gate.push(frame(), rate), "listen");
  assert.equal(gate.push(frame(0.1), rate), "listen");
});
test("continuous speech is bounded to sixty seconds", () => {
  const gate = new VoiceActivity();
  for (let i = 0; i < 1199; i++)
    assert.equal(gate.push(frame(0.1), rate), "listen");
  assert.equal(gate.push(frame(0.1), rate), "finish");
});
test("WAV encoding preserves mono PCM, sample rate and clipped sample values", async () => {
  const blob = encodeWav([new Float32Array([-2, 0, 2])], rate);
  const bytes = await blob.arrayBuffer();
  const view = new DataView(bytes);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), "RIFF");
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), rate);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(46, true), 0);
  assert.equal(view.getInt16(48, true), 32767);
});
