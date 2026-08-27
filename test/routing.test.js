const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  isOpenAiCompatibilityRoute, isMetadataRoute, requestModelFromBody, classifyRoute,
} = require("../lib/routing");

test("recognizes OpenAI compatibility paths under supported Gemini API versions", () => {
  for (const pathname of ["/v1alpha/openai/models", "/v1beta/openai/chat/completions", "/v1/openai/embeddings"]) {
    assert.equal(isOpenAiCompatibilityRoute(pathname), true);
  }
  assert.equal(isOpenAiCompatibilityRoute("/v1beta/models"), false);
  assert.equal(isOpenAiCompatibilityRoute("/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"), false);
});

test("classifies OpenAI model discovery and file routes as non-inference metadata", () => {
  for (const pathname of [
    "/v1beta/openai/models",
    "/v1beta/openai/models/gemini-3.1-flash-lite",
    "/upload/v1beta/files",
    "/v1beta/openai/files",
    "/v1beta/openai/batches",
  ]) {
    assert.equal(isMetadataRoute(pathname, pathname.includes("/models") ? "GET" : "POST"), true);
    assert.equal(classifyRoute(pathname, "GET", null, null, Buffer.alloc(0)).trackUsage, false);
  }
});

test("uses request-body model for OpenAI inference routes", () => {
  const body = Buffer.from(JSON.stringify({ model: "gemini-3.1-flash-lite", messages: [] }));
  assert.equal(requestModelFromBody(body), "gemini-3.1-flash-lite");
  const route = classifyRoute("/v1beta/openai/chat/completions", "POST", null, null, body);
  assert.equal(route.kind, "inference");
  assert.equal(route.model, "gemini-3.1-flash-lite");
  assert.equal(route.statsModel, "gemini-3.1-flash-lite");
  assert.equal(route.trackUsage, true);
  assert.equal("balanceByModel" in route, false);
});

test("does not treat malformed or missing model bodies as a real model", () => {
  assert.equal(requestModelFromBody(Buffer.from("{bad")), null);
  const route = classifyRoute("/v1beta/openai/chat/completions", "POST", null, null, Buffer.from("{}"));
  assert.equal(route.statsModel, "/v1beta/openai/chat/completions");
});


test("short-circuits metadata classification before inspecting request bodies", () => {
  const route = classifyRoute("/v1beta/openai/models", "GET", null, null, Buffer.from("not-json"));
  assert.deepEqual(route, { kind: "metadata", model: null, trackUsage: false });
});
