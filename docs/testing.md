# Testing

## Backend

Start the local stack with a generated database password. The deterministic suites do not need a Groq key:

```bash
docker compose up --build -d --wait
docker compose --profile test build tests
docker compose --profile test run --rm tests sh -c \
  'ruff check app tests alembic && ruff format --check app tests alembic && pytest -q'
```

The tests create a random PostgreSQL schema, apply the real migrations twice, run against that schema, then remove it. Application tables are not truncated. Provider responses are fixtures scoped to the tests.

Coverage includes workspace isolation, conversation lifecycle, automatic and explicit memory, deletion/correction, cross-conversation context, request idempotency, concurrent writes, workflow transitions, interruptions, invalid inputs, stale forecasts, outages, explicit confirmation, and owned-message speech. Provider tests exercise HTTP contracts, malformed responses, bounded retries, Retry-After, authentication failures, and ambiguous timeouts.

## Frontend

Use Node.js 24 and a local stack with `GROQ_API_KEY` empty for the deterministic browser suite:

```bash
cd frontend
npm ci
npm run typecheck
npm run test:audio
npx playwright install --with-deps chromium
npm run test:e2e
```

Set `E2E_BASE_URL` when using another local port. Browser contexts have separate cookies and clean up their own application data. Audio/network fixtures test pause detection, automatic sending/listening, silence suppression, cancellation, stereo downmix, microphone closure during playback, speech fallback, Arabic auto-detection, translated navigation, RTL layout, and planner recovery on desktop/mobile viewports.

The mobile suite uses Chromium emulation, not native Safari. Audio unit tests cover waveform encoding and turn boundaries; browser tests do not prove physical microphone or speaker behavior.

## Optional live checks

With a server-side Groq key configured:

```bash
python3 scripts/live_acceptance.py --url http://localhost:3000
node frontend/scripts/live-voice.cjs
```

These make real provider requests and incur usage. Run them sequentially to reduce quota contention. They create new anonymous workspaces and delete only their own conversations, memories, and plans. The API journey covers real model recall, natural-language workflow updates, Open-Meteo, interruptions, corrections, confirmation, and isolation. The voice check uses synthesized microphone input with real Whisper/chat/speech and waits for native playback to end before verifying that listening resumes.

Use `E2E_BASE_URL` for another origin, and pass `en` or `ar` to run one voice language. A physical microphone, audible playback, and target-device permissions still need manual verification.

## Persistence smoke check

The following uses real weather and a disposable workspace. Its state file stores that workspace's cookie and IDs with mode 0600:

```bash
python3 scripts/smoke.py seed --state /tmp/sarjy-smoke.json
docker compose restart db backend
docker compose up -d --wait
python3 scripts/smoke.py verify --state /tmp/sarjy-smoke.json
python3 scripts/smoke.py cleanup --state /tmp/sarjy-smoke.json
```

If seeding stops partway through, use the same state file for cleanup before starting again. Do not point restart commands at a shared environment during active use.

## CI

GitHub Actions builds the application images, checks migrations and the PostgreSQL-backed tests, runs Ruff and TypeScript, verifies the combined production image against PostgreSQL, and runs the audio/error and desktop/mobile browser suites. External-provider availability and physical-device acceptance are separate from deterministic CI.
