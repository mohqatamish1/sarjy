import test from "node:test";
import assert from "node:assert/strict";
import { friendlyError } from "../src/lib/errors.ts";

test("provider diagnostics are replaced with friendly copy", () => {
  const error = Object.assign(
    new Error("Groq API key rejected: private diagnostic"),
    { code: "credentials_invalid" },
  );
  assert.equal(
    friendlyError(error),
    "Sarjy is temporarily unavailable. Please try again shortly.",
  );
  assert.equal(
    friendlyError("Groq API key rejected: private diagnostic"),
    "The connection was interrupted. Please try again.",
  );
});
test("workflow recovery instructions survive friendly error rendering", () => {
  const message = friendlyError({ code: "forecast_refreshed" });
  assert.equal(
    message,
    "The forecast has changed. Review the updated plan and confirm again.",
  );
  assert.equal(friendlyError(message), message);
  assert.match(
    friendlyError({ code: "workflow_closed" }),
    /Start a new conversation/,
  );
});
