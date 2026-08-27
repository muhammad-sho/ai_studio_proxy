const assert = require("node:assert/strict");
const { once } = require("node:events");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createGeminiProxy } = require("../lib/gemini-proxy");

function fakeHttps(status, headers, body, observed) {
  return {
    request(options, callback) {
      observed.options = options;
      const request = new EventEmitter();
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = status;
        response.headers = headers;
        setImmediate(() => {
          callback(response);
          setImmediate(() => {
            if (body.length) response.emit("data", Buffer.from(body));
            response.emit("end");
          });
        });
      };
      request.destroy = (error) => setImmediate(() => request.emit("error", error));
      return request;
    },
  };
}

function proxyFor(status, headers, body, observed = {}) {
  return createGeminiProxy({
    https: fakeHttps(status, headers, body, observed),
    crypto: {},
    db: {},
    prep: () => ({ all: () => [], get: () => null, run: () => ({}) }),
    log: () => {},
    dbg: () => {},
    maskKey: () => "masked...",
    json: () => {},
    requestPath: () => "/v1beta/models/test:generateContent",
    statsModelName: () => "test",
    REQUEST_TIMEOUT_MS: 1_000,
    MAX_RESPONSE_BYTES: 1_024,
    TRANSIENT_COOLDOWN_SECONDS: 60,
    MODELS_CACHE_TTL_MS: 60_000,
    poolKeys: () => [],
    setMeta: () => {},
    getMeta: () => null,
    pacificDayStart: () => 0,
    resolveClientKey: () => null,
    clientAddress: () => "127.0.0.1",
    maskSecrets: (value) => value,
    clipBody: (value) => String(value),
    upstreamErrorPayload: () => null,
    errorCodeFromPayload: () => null,
    recordLog: () => {},
    recordUsageRow: () => {},
    setCooldown: () => {},
    setCooldownUntil: () => {},
    nextPacificReset: () => 0,
    isOpenAiCompatibilityRoute: (pathname) => /^\/v1beta\/openai(?:\/|$)/.test(pathname),
  });
}

test("relays successful Gemini responses immediately when streaming is requested", async () => {
  const observed = {};
  const proxy = proxyFor(200, { "content-type": "application/json", "content-length": "11" }, '{"ok":true}', observed);
  const result = await proxy.forwardToGemini(
    { url: "/v1beta/models/test:generateContent", method: "POST", headers: { "x-goog-api-key": "client-key", host: "proxy" } },
    Buffer.from("{}"),
    "gemini-key",
    { stream: true }
  );

  assert.equal(result.stream, true);
  assert.equal(result.status, 200);
  assert.equal(observed.options.headers["x-goog-api-key"], "gemini-key");
  assert.equal(observed.options.headers.authorization, undefined);
  assert.equal(observed.options.headers["content-length"], 2);

  const chunks = [];
  result.response.on("data", (chunk) => chunks.push(chunk));
  await once(result.response, "end");
  assert.equal(Buffer.concat(chunks).toString(), '{"ok":true}');
});

test("keeps unknown-size non-SSE responses on the bounded-buffer path", async () => {
  const proxy = proxyFor(200, { "content-type": "application/json" }, '{"ok":true}');
  const result = await proxy.forwardToGemini(
    { url: "/v1beta/models/test:generateContent", method: "POST", headers: {} },
    Buffer.from("{}"),
    "gemini-key",
    { stream: true }
  );

  assert.equal(result.stream, undefined);
  assert.equal(result.body.toString(), '{"ok":true}');
});

test("keeps Gemini error responses buffered for existing error classification", async () => {
  const proxy = proxyFor(429, { "content-type": "application/json" }, '{"error":{"status":"RESOURCE_EXHAUSTED"}}');
  const result = await proxy.forwardToGemini(
    { url: "/v1beta/models/test:generateContent", method: "POST", headers: {} },
    Buffer.from("{}"),
    "gemini-key",
    { stream: true }
  );

  assert.equal(result.stream, undefined);
  assert.equal(result.status, 429);
  assert.equal(result.body.toString(), '{"error":{"status":"RESOURCE_EXHAUSTED"}}');
});


test("uses Bearer authentication for OpenAI-compatible upstream routes", async () => {
  const observed = {};
  const proxy = proxyFor(200, { "content-type": "application/json", "content-length": "11" }, '{"ok":true}', observed);
  const result = await proxy.forwardToGemini(
    { url: "/v1beta/openai/chat/completions", method: "POST", headers: { authorization: "Bearer proxy-client-key", host: "proxy" } },
    Buffer.from("{}"),
    "gemini-key",
    { stream: true }
  );

  assert.equal(result.stream, true);
  assert.equal(observed.options.headers.authorization, "Bearer gemini-key");
  assert.equal(observed.options.headers["x-goog-api-key"], undefined);
});
