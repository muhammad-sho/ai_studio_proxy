const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  isOpenAiCompatibilityRoute, isMetadataRoute, requestModelFromBody, classifyRoute,
} = require("../lib/routing");

test("recognizes OpenAI compatibility paths under supported Gemini API versions", () => {
  for (const pathname of ["/v1alpha/openai/models", "/v1beta/openai/chat/completions", "/v1/openai/embeddings"]) {
    assert.equal(isOpenAiCompatibilityRoute(pathname), true);
  }
  for (const pathname of ["/v1/chat/completions", "/v1/embeddings", "/v1/images/generations"]) {
    assert.equal(isOpenAiCompatibilityRoute(pathname, { authorization: "Bearer proxy-client-key" }), true);
  }
  assert.equal(isOpenAiCompatibilityRoute("/v1beta/models"), false);
  assert.equal(isOpenAiCompatibilityRoute("/v1/chat/completions", { "x-goog-api-key": "proxy-client-key" }), false);
  assert.equal(isOpenAiCompatibilityRoute("/v1/models", { authorization: "Bearer proxy-client-key" }), true);
  assert.equal(isOpenAiCompatibilityRoute("/v1/models", { "x-goog-api-key": "proxy-client-key" }), false);
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
  assert.equal(route.statsModel, null);\n  assert.equal(route.logModel, "[unidentified inference]");\n  assert.equal(route.trackUsage, false);
});


test("short-circuits metadata classification before inspecting request bodies", () => {
  const route = classifyRoute("/v1beta/openai/models", "GET", null, null, Buffer.from("not-json"));
  assert.deepEqual(route, { kind: "metadata", model: null, statsModel: null, logModel: "[metadata]", trackUsage: false });
  const alias = classifyRoute("/v1/models", "GET", null, null, Buffer.from("not-json"), { authorization: "Bearer proxy-client-key" });
  assert.deepEqual(alias, { kind: "metadata", model: null, trackUsage: false });
});


test("keeps resource and unknown routes out of model accounting", () => {
  for (const [pathname, method] of [
    ["/v1beta/batches", "POST"],
    ["/v1beta/cachedContents", "POST"],
    ["/v1beta/operations/123", "GET"],
    ["/v1beta/tunedModels", "GET"],
  ]) {
    const route = classifyRoute(pathname, method, null, null, Buffer.alloc(0));
    assert.equal(route.kind, "metadata");
    assert.equal(route.trackUsage, false);
    assert.equal(route.statsModel, null);
  }
  const unknown = classifyRoute("/v1beta/some-resource", "POST", null, null, Buffer.from("{}"));
  assert.equal(unknown.kind, "passthrough");
  assert.equal(unknown.trackUsage, false);
  assert.equal(unknown.statsModel, null);
  assert.equal(unknown.logModel, "[untracked endpoint]");
});

test("only recognized model actions are metered", () => {
  const valid = classifyRoute("/v1beta/models/gemini-test:generateContent", "POST", "gemini-test", "generateContent", Buffer.from("{}"));
  assert.equal(valid.kind, "inference");
  assert.equal(valid.trackUsage, true);
  const unsupported = classifyRoute("/v1beta/models/gemini-test:unknownAction", "POST", "gemini-test", "unknownAction", Buffer.from("{}"));
  assert.equal(unsupported.kind, "passthrough");
  assert.equal(unsupported.trackUsage, false);
  assert.equal(unsupported.statsModel, null);
});
