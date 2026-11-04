import { test, expect, Page } from "@playwright/test";

test("retry after a failed refresh does not duplicate a recorded turn", async ({
  page,
}) => {
  await boot(page);
  let failOnce = true;
  await page.route("**/api/conversations/*", (route) => {
    if (route.request().method() === "GET" && failOnce) {
      failOnce = false;
      return route.fulfill({
        status: 503,
        json: { detail: "The connection was interrupted. Try again." },
      });
    }
    return route.continue();
  });
  const composer = page.getByRole("textbox", { name: "Message Sarjy" });
  await composer.fill("Remember that I like long walks");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByRole("alert", { name: "Assistant error" }),
  ).toContainText("connection was interrupted");
  await expect(composer).toHaveValue("Remember that I like long walks");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText("Saved to your memory: I like long walks", { exact: true }),
  ).toBeVisible();
  const list = await page.request
    .get("/api/conversations")
    .then((r) => r.json());
  const detail = await page.request
    .get(`/api/conversations/${list[0].id}`)
    .then((r) => r.json());
  expect(detail.messages).toHaveLength(2);
});

async function boot(page: Page) {
  await page.goto("/");
  await expect(
    page.getByRole("textbox", { name: "Message Sarjy" }),
  ).toBeVisible();
}

async function navigate(page: Page, name: string) {
  const menu = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: false })
    .click();
}

async function planner(page: Page) {
  const region = page.getByRole("region", { name: "Outing planner" });
  if (!(await region.isVisible()))
    await page
      .getByRole("button", { name: "Outing planner", exact: true })
      .click();
  return region;
}

test.afterEach(async ({ page }) => {
  // Clean up only the current isolated browser workspace, including auto-created empty chats.
  const conversations = await page.request
    .get("/api/conversations")
    .then((r) => r.json());
  for (const item of conversations)
    await page.request.delete(`/api/conversations/${item.id}`);
  const memories = await page.request
    .get("/api/memories")
    .then((r) => r.json());
  for (const item of memories)
    await page.request.delete(`/api/memories/${item.id}`);
});

test("responsive welcome, accessible controls, and no browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await boot(page);
  await expect(
    page.getByRole("heading", { name: "What’s on your mind?" }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Spoken replies" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.getByRole("switch", { name: "Spoken replies" }).click();
  await expect(
    page.getByRole("switch", { name: "Spoken replies" }),
  ).toHaveAttribute("aria-checked", "false");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("service errors are friendly and the conversation survives reload", async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByText("AI setup needed", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("textbox", { name: "Message Sarjy" })
    .fill("Explain a black hole");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText(
      "Sarjy is temporarily unavailable. Please try again shortly.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Explain a black hole", { exact: true }).last(),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Sarjy is temporarily unavailable. Please try again shortly.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("explicit memory works across conversations and can be forgotten", async ({
  page,
}) => {
  await boot(page);
  await navigate(page, "Memory");
  await page
    .getByRole("textbox", { name: "Something to remember" })
    .fill("I enjoy quiet cafés");
  await page.getByRole("button", { name: "Save memory", exact: true }).click();
  await expect(
    page.getByText("I enjoy quiet cafés", { exact: true }),
  ).toBeVisible();
  const menu = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Message Sarjy" })
    .fill("what do you remember?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText(/Here’s what I remember about you/),
  ).toBeVisible();
  await navigate(page, "Memory");
  await page
    .getByRole("button", { name: "Forget: I enjoy quiet cafés" })
    .click();
  await expect(
    page.getByText(/Tell Sarjy a little about yourself/),
  ).toBeVisible();
});

test("outing state survives reload, pause, interruption, and resume", async ({
  page,
}) => {
  await boot(page);
  let region = await planner(page);
  await region
    .getByRole("button", { name: "Plan an outing", exact: true })
    .click();
  await region
    .getByRole("textbox", { name: "City", exact: true })
    .fill("Riyadh");
  await region
    .getByRole("button", { name: "Save progress", exact: true })
    .click();
  await expect(
    region.getByRole("button", { name: "Save progress", exact: true }),
  ).toBeEnabled();
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message Sarjy" }),
  ).toBeVisible();
  region = await planner(page);
  await expect(
    region.getByRole("textbox", { name: "City", exact: true }),
  ).toHaveValue("Riyadh");
  await region
    .getByRole("button", { name: "Pause outing", exact: true })
    .click();
  await expect(
    region.getByText("Paused · your details are saved"),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "Close outing planner", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "Close outing planner", exact: true })
      .click();
  await page
    .getByRole("textbox", { name: "Message Sarjy" })
    .fill("what do you remember?");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page.getByText(/You haven't saved any memories yet/),
  ).toBeVisible();
  region = await planner(page);
  await region
    .getByRole("button", { name: "Resume outing", exact: true })
    .click();
  await expect(region.getByText("Let's fill in the details")).toBeVisible();
  await expect(
    region.getByRole("textbox", { name: "City", exact: true }),
  ).toHaveValue("Riyadh");
});

test("weather failure is visible and cannot produce a confirmed plan", async ({
  page,
}) => {
  await boot(page);
  const region = await planner(page);
  await region
    .getByRole("button", { name: "Plan an outing", exact: true })
    .click();
  await region
    .getByRole("textbox", { name: "City", exact: true })
    .fill("Riyadh");
  const date = new Date();
  date.setDate(date.getDate() + 1);
  await region.locator("#outing-date").fill(date.toISOString().slice(0, 10));
  await region.getByRole("spinbutton", { name: "People" }).fill("2");
  await region
    .getByRole("textbox", { name: "What sounds good?" })
    .fill("Coffee and walking");
  await page.route("**/api/conversations/*/workflow", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({
            code: "weather_unavailable",
            detail:
              "Open-Meteo is unavailable. Your details are saved; retry when the weather service is back.",
          }),
        })
      : route.continue(),
  );
  await region
    .getByRole("button", { name: "Check weather & build plan" })
    .click();
  await expect(
    page.getByRole("alert", { name: "Assistant error" }),
  ).toContainText("The forecast is unavailable");
  await expect(
    region.getByRole("button", { name: "Confirm plan", exact: true }),
  ).toHaveCount(0);
});

test("microphone permission denial provides a text fallback", async ({
  page,
}) => {
  await voiceSessionConfigured(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () =>
        Promise.reject(new DOMException("Denied", "NotAllowedError")),
    });
  });
  await boot(page);
  await page.getByRole("button", { name: "Let’s talk", exact: true }).click();
  await expect(
    page.getByRole("alert", { name: "Assistant error" }),
  ).toContainText("Microphone access was denied");
  await expect(
    page.getByRole("textbox", { name: "Message Sarjy" }),
  ).toBeEnabled();
});

// PCM input and reply audio fixtures exercise the actual audio graph and media playback.
function wav(seconds = 0.1) {
  const rate = 16000,
    samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  return data;
}

async function voiceSessionConfigured(page: Page) {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), ai_configured: true },
    });
  });
}

async function voiceInput(page: Page, silent = false, stereo = false) {
  await voiceSessionConfigured(page);
  await page.addInitScript(
    ({ silent, stereo }) => {
      const state = window as unknown as { microphoneStarts: number };
      state.microphoneStarts = 0;
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: async () => {
          state.microphoneStarts++;
          const context = new AudioContext();
          const oscillator = context.createOscillator();
          const output = context.createMediaStreamDestination();
          if (stereo) {
            const merger = context.createChannelMerger(2);
            oscillator.connect(merger, 0, 1); // Only the right input contains speech.
            merger.connect(output);
          } else oscillator.connect(output);
          // Only the first turn contains speech-like energy, followed by actual silence.
          if (!silent && state.microphoneStarts === 1) {
            oscillator.start(context.currentTime + 0.2);
            oscillator.stop(context.currentTime + 1.1);
          }
          return output.stream;
        },
      });
    },
    { silent, stereo },
  );
}

async function replyAudio(page: Page, seconds = 0.1) {
  await page.route("**/api/messages/*/speech?part=*", (route) =>
    route.fulfill({
      contentType: "audio/wav",
      headers: { "X-Speech-Parts": "1" },
      body: wav(seconds),
    }),
  );
}

test("hands-free voice detects a pause, sends, speaks, and listens for the next turn", async ({
  page,
}) => {
  await voiceInput(page);
  await replyAudio(page);
  let uploads = 0;
  await page.route("**/api/transcriptions", (route) => {
    uploads++;
    expect(
      route.request().postDataBuffer()?.includes(Buffer.from("utterance.wav")),
    ).toBe(true);
    return route.fulfill({
      json: { text: "Remember that my favorite color is blue" },
    });
  });
  await boot(page);
  await page.getByRole("button", { name: "Let’s talk", exact: true }).click();
  await expect(page.getByRole("log")).toContainText(
    "Saved to your memory: my favorite color is blue",
    { timeout: 15000 },
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { microphoneStarts: number }).microphoneStarts,
      ),
    )
    .toBe(2);
  await page
    .getByRole("button", { name: "End voice chat", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message Sarjy" }),
  ).toBeEnabled();
  expect(uploads).toBe(1);
});

test("silence produces no transcription upload or invented message", async ({
  page,
}) => {
  await voiceInput(page, true);
  let uploads = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/transcriptions")) uploads++;
  });
  await boot(page);
  await page.getByRole("button", { name: "Let’s talk", exact: true }).click();
  await expect(
    page.getByRole("alert", { name: "Assistant error" }),
  ).toContainText("I couldn’t hear you clearly", { timeout: 16000 });
  expect(uploads).toBe(0);
  await expect(page.getByRole("log")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "End voice chat" }),
  ).toHaveCount(0);
});

test("ending during transcription prevents an automatic send and microphone restart", async ({
  page,
}) => {
  await voiceInput(page);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const uploaded = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route("**/api/transcriptions", async (route) => {
    reached();
    await hold;
    await route
      .fulfill({ json: { text: "Remember that this must not be saved" } })
      .catch(() => undefined);
  });
  await boot(page);
  await page.getByRole("button", { name: "Let’s talk", exact: true }).click();
  await uploaded;
  await page.getByRole("button", { name: "End voice chat" }).click();
  release();
  await expect(
    page.getByRole("textbox", { name: "Message Sarjy" }),
  ).toBeEnabled();
  await page.waitForTimeout(300);
  await expect(page.getByRole("log")).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { microphoneStarts: number }).microphoneStarts,
    ),
  ).toBe(1);
});

test("microphone stays closed while the reply is playing", async ({ page }) => {
  await voiceInput(page);
  await replyAudio(page, 3);
  await page.route("**/api/transcriptions", (route) =>
    route.fulfill({ json: { text: "Remember that I like coffee" } }),
  );
  await boot(page);
  await page.getByRole("button", { name: "Let’s talk", exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Voice chat controls" })
      .getByRole("status"),
  ).toHaveText("Sarjy is speaking…", { timeout: 15000 });
  await page.waitForTimeout(400);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { microphoneStarts: number }).microphoneStarts,
    ),
  ).toBe(1);
  await page.getByRole("button", { name: "End voice chat" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Sarjy" }),
  ).toBeEnabled();
});

test("Arabic speech is auto-detected and saves explicit Arabic memory", async ({
  page,
}) => {
  await voiceInput(page);
  await replyAudio(page);
  await page.route("**/api/transcriptions", (route) => {
    expect(route.request().postDataBuffer()?.toString()).toContain(
      'name="language"\r\n\r\nauto',
    );
    return route.fulfill({ json: { text: "تذكر أن لوني المفضل أزرق" } });
  });
  await boot(page);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.getByRole("button", { name: "Let’s talk", exact: true }).click();
  await expect(page.getByRole("log")).toContainText(
    "حفظت في ذاكرتك: لوني المفضل أزرق",
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "End voice chat" }).click();
});

test("read aloud passes the response to browser speech synthesis", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as { spoken: string[] }).spoken = [];
    Object.defineProperty(window.speechSynthesis, "getVoices", {
      value: () => [{ lang: "en-US", name: "Test English" }],
    });
    Object.defineProperty(SpeechSynthesisUtterance.prototype, "voice", {
      set: () => {},
      configurable: true,
    });
    Object.defineProperty(window.speechSynthesis, "speak", {
      value: (utterance: SpeechSynthesisUtterance) => {
        (window as unknown as { spoken: string[] }).spoken.push(utterance.text);
      },
    });
    Object.defineProperty(window.speechSynthesis, "cancel", {
      value: () => {},
    });
  });
  await boot(page);
  // Exercise manual playback independently from the default automatic response.
  await page.getByRole("switch", { name: "Spoken replies" }).click();
  await page
    .getByRole("textbox", { name: "Message Sarjy" })
    .fill("Remember that I like art");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("button", { name: "Read aloud", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { spoken: string[] }).spoken[0],
      ),
    )
    .toContain("I like art");
  await expect(
    page.getByRole("button", { name: "Stop reading", exact: true }),
  ).toBeVisible();
});

test("a stereo microphone with speech only on the right channel is downmixed", async ({
  page,
}) => {
  await voiceInput(page, false, true);
  await replyAudio(page);
  await page.route("**/api/transcriptions", (route) =>
    route.fulfill({
      json: { text: "Remember that both microphone channels work" },
    }),
  );
  await boot(page);
  await page.getByRole("button", { name: "Let’s talk", exact: true }).click();
  await expect(page.getByRole("log")).toContainText(
    "Saved to your memory: both microphone channels work",
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "End voice chat" }).click();
});

test("simple voice controls, language persistence, Arabic navigation and starter cards", async ({
  page,
}) => {
  await boot(page);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(
    page.getByText(/Groq|AI configured|Speech language|System default/),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Think out loud" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Sarjy" }),
  ).toHaveValue("Help me think through an idea");
  await page.getByRole("button", { name: "Make it personal" }).click();
  await expect(
    page.getByRole("heading", { name: "A little more you." }),
  ).toBeVisible();
  await navigate(page, "Conversation");
  await page.getByRole("button", { name: "Switch to Arabic" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { name: "بمَ تفكر اليوم؟" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "بمَ تفكر اليوم؟" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "خطط لنزهة", exact: false })
    .first()
    .click();
  const panel = page.getByRole("region", { name: "مخطط النزهة" });
  await expect(panel.getByLabel("المدينة", { exact: true })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("في أي مدينة");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  // Close the mobile planner before changing the page language.
  const close = page.getByRole("button", { name: "إغلاق مخطط النزهة" });
  if (await close.isVisible()) await close.click();
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});

test("technical provider errors are hidden and failed turns can be retried", async ({
  page,
}) => {
  await boot(page);
  await page
    .getByRole("textbox", { name: "Message Sarjy" })
    .fill("Explain rainbows");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("log")).toContainText(
    "Sarjy is temporarily unavailable",
  );
  await expect(page.getByRole("log")).not.toContainText(
    /Groq|GROQ_API_KEY|backend|\.env/,
  );
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry", exact: true }),
  ).toBeEnabled();
  const list = await page.request
    .get("/api/conversations")
    .then((r) => r.json());
  const detail = await page.request
    .get(`/api/conversations/${list[0].id}`)
    .then((r) => r.json());
  expect(detail.messages).toHaveLength(2);
});
