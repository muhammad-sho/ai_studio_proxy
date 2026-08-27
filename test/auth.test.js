const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { test } = require("node:test");
const { createAuth } = require("../lib/auth");
const { isOpenAiCompatibilityRoute } = require("../lib/routing");

function authFor(clientKey) {
  const keyHash = crypto.createHash("sha256").update(clientKey).digest("hex");
  return createAuth({
    prep: () => ({ get: (hash) => hash === keyHash ? { id: 7, label: "OpenAI client" } : null }),
    crypto,
    trustProxy: false,
    sessionTtlMs: 1_000,
    cookieSession: "session",
    cookieCsrf: "csrf",
    log: () => {},
    isOpenAiCompatibilityRoute,
  });
}

test("accepts a proxy client key from OpenAI Bearer authentication only on OpenAI routes", () => {
  const auth = authFor("proxy-client-key");

  for (const url of ["/v1beta/openai/chat/completions", "/v1/chat/completions", "/v1/models"]) {
    assert.deepEqual(
      auth.resolveClientKey({ url, headers: { authorization: "Bearer proxy-client-key" } }),
      { id: 7, label: "OpenAI client" }
    );
  }
  assert.equal(
    auth.resolveClientKey({ url: "/v1beta/models/gemini-3.7-flash:generateContent", headers: { authorization: "Bearer proxy-client-key" } }),
    null
  );
});
