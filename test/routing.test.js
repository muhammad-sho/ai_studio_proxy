const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isOpenAiCompatibilityRoute } = require("../lib/routing");

test("recognizes OpenAI compatibility paths under supported Gemini API versions", () => {
  for (const pathname of ["/v1alpha/openai/models", "/v1beta/openai/chat/completions", "/v1/openai/embeddings"]) {
    assert.equal(isOpenAiCompatibilityRoute(pathname), true);
  }
  assert.equal(isOpenAiCompatibilityRoute("/v1beta/models"), false);
  assert.equal(isOpenAiCompatibilityRoute("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"), false);
});
