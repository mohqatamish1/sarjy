// Opt-in live provider check: node frontend/scripts/live-voice.cjs
// Uses synthetic microphone audio, real Whisper/chat/TTS, and native audio playback.
// Requires the running app to have a Groq key; incurs small provider usage.
const { chromium, request, expect, devices } = require('@playwright/test');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const base = process.env.E2E_BASE_URL || 'http://localhost:3000';
const languages = process.argv.slice(2).length ? process.argv.slice(2) : ['en', 'ar'];
if (languages.some(language => !['en', 'ar'].includes(language))) throw new Error('Use en and/or ar');

async function json(response) {
  expect(response.ok(), `${response.status()} ${response.url()}`).toBeTruthy();
  return response.json();
}
async function cleanup(client) {
  for (const conversation of await json(await client.get(`${base}/api/conversations`)))
    expect((await client.delete(`${base}/api/conversations/${conversation.id}`)).ok()).toBeTruthy();
  for (const memory of await json(await client.get(`${base}/api/memories`)))
    expect((await client.delete(`${base}/api/memories/${memory.id}`)).ok()).toBeTruthy();
  expect(await json(await client.get(`${base}/api/plans`))).toEqual([]);
}
async function fixture(language, directory) {
  const client = await request.newContext(); // Separate workspace, never the user's browser cookie.
  try {
    expect((await json(await client.get(`${base}/api/session`))).ai_configured).toBe(true);
    const conversation = await json(await client.post(`${base}/api/conversations`));
    const content = language === 'ar'
      ? 'كرر هذا السؤال حرفيا فقط دون الإجابة عليه: ما عاصمة المملكة العربية السعودية؟'
      : 'Repeat only this question verbatim, without answering it: What is the capital of Saudi Arabia?';
    const reply = await json(await client.post(`${base}/api/conversations/${conversation.id}/messages`, {
      data: {content, request_id: randomUUID()},
    }));
    expect(reply.kind).not.toBe('error');
    expect(reply.content).toMatch(language === 'ar' ? /عاصمة/ : /capital/i);
    const response = await client.post(`${base}/api/messages/${reply.id}/speech?part=0`);
    expect(response.status()).toBe(200);
    expect(response.headers()['x-speech-parts']).toBe('1');
    const wav = Buffer.from(await response.body());
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(34)).toBe(16);
    // The fake microphone repeats its file. A silent tail lets the real 1.3s VAD finish first.
    const padded = Buffer.concat([wav, Buffer.alloc(wav.readUInt32LE(24) * wav.readUInt16LE(32) * 2)]);
    padded.writeUInt32LE(padded.length - 8, 4);
    padded.writeUInt32LE(padded.length - 44, 40);
    const path = join(directory, `${language}.wav`);
    await writeFile(path, padded);
    return path;
  } finally {
    await cleanup(client);
    await client.dispose();
  }
}
async function roundTrip(language, mobile, wav) {
  const browser = await chromium.launch({args: [
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required',
  ]});
  const context = await browser.newContext({
    ...(mobile ? devices['iPhone 13'] : {viewport: {width: 1440, height: 1000}}),
    permissions: ['microphone'],
  });
  const page = await context.newPage();
  const transcription = [], speech = [], transcripts = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    if (response.url().endsWith('/transcriptions')) {
      transcription.push(response.status());
      void response.json().then(body => transcripts.push(body.text)).catch(() => {});
    }
    if (response.url().includes('/speech?')) speech.push(response.status());
  });
  await page.addInitScript(() => {
    window.voiceProof = {starts: [], constraints: [], plays: 0, languages: [], replyEnds: [], liveMicDuringReply: false};
    const fetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      if (String(input).endsWith('/transcriptions') && options?.body instanceof FormData)
        window.voiceProof.languages.push(options.body.get('language'));
      return fetch(input, options);
    };
    const streams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.voiceProof.starts.push(performance.now());
      window.voiceProof.constraints.push(constraints);
      const stream = await original(constraints);
      streams.push(stream);
      return stream;
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (++window.voiceProof.plays > 1) { // First play unlocks a short silent audio clip.
        window.voiceProof.liveMicDuringReply ||= streams.some(s => s.getTracks().some(t => t.readyState === 'live'));
        this.addEventListener('ended', () => window.voiceProof.replyEnds.push(performance.now()), {once: true});
      }
      return play.apply(this, args);
    };
  });
  try {
    await page.goto(base);
    await expect(page.getByRole('textbox', {name: 'Message Sarjy'})).toBeVisible();
    if (language === 'ar') await page.getByRole('button', {name: 'Switch to Arabic'}).click();
    await page.getByRole('button', {name: language === 'ar' ? 'لنتحدث' : 'Let’s talk', exact: true}).click();
    await expect(page.locator('.message-assistant').last()).toContainText(language === 'ar' ? 'الرياض' : /Riyadh/i, {timeout: 90000});
    await expect.poll(() => page.evaluate(() => window.voiceProof.starts.length), {timeout: 90000}).toBe(2);
    await page.getByRole('button', {name: language === 'ar' ? 'إنهاء المحادثة الصوتية' : 'End voice chat', exact: true}).click();
    const proof = await page.evaluate(() => window.voiceProof);
    expect(proof.replyEnds.length).toBeGreaterThan(0);
    expect(proof.starts[1]).toBeGreaterThan(proof.replyEnds.at(-1));
    expect(proof.liveMicDuringReply).toBe(false);
    expect(proof.constraints.every(c => !c.audio?.deviceId)).toBe(true);
    expect(transcription).toEqual([200]);
    expect(proof.languages).toEqual(['auto']);
    expect(speech.length).toBeGreaterThan(0);
    expect(speech.every(s => s === 200)).toBe(true);
    expect(errors).toEqual([]);
    console.log(`PASS ${language}/${mobile ? 'mobile' : 'desktop'}: auto language, pause/send, live Whisper/chat/speech, native playback ended, mic reopened, End.`);
  } catch (error) {
    console.error(`${language}/${mobile ? 'mobile' : 'desktop'} transcripts:`, transcripts);
    console.error(await page.locator('.message-list').innerText().catch(() => 'No messages'));
    throw error;
  } finally {
    await page.close(); // Stops media and outstanding page requests.
    try { await cleanup(context.request); }
    finally { await browser.close(); }
  }
}
(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sarjy-live-voice-'));
  try {
    for (const language of languages) {
      const wav = await fixture(language, directory);
      for (const mobile of [false, true]) {
        await roundTrip(language, mobile, wav);
      }
    }
    console.log(`PASS: ${languages.length * 2} real-provider voice loops; physical microphone/speaker acceptance remains manual.`);
  } finally { await rm(directory, {recursive: true, force: true}); }
})().catch(error => {console.error(error); process.exitCode = 1;});
