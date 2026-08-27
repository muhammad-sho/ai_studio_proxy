const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadConfig } = require("../lib/config");

test("uses safe defaults when numeric environment values are invalid", () => {
  const config = loadConfig({
    ADMIN_PORT: "0",
    API_PORT: "70000",
    REQUEST_TIMEOUT_MS: "Infinity",
    MAX_BODY_BYTES: "not-a-number",
    MAX_RESPONSE_BYTES: "-1",
    LOG_BODY_MAX_BYTES: "0",
    MAX_LOG_ENTRIES: "49",
    MODELS_CACHE_TTL_HOURS: "0",
  });

  assert.equal(config.ADMIN_PORT, 9009);
  assert.equal(config.API_PORT, 9008);
  assert.equal(config.REQUEST_TIMEOUT_MS, 120_000);
  assert.equal(config.MAX_BODY_BYTES, 50 * 1024 * 1024);
  assert.equal(config.MAX_RESPONSE_BYTES, 50 * 1024 * 1024);
  assert.equal(config.LOG_BODY_MAX_BYTES, 64 * 1024);
  assert.equal(config.MAX_LOG_ENTRIES, 50);
  assert.equal(config.MODELS_CACHE_TTL_MS, 24 * 60 * 60 * 1000);
});

test("keeps valid numeric environment overrides", () => {
  const config = loadConfig({
    ADMIN_PORT: "9109",
    API_PORT: "9108",
    REQUEST_TIMEOUT_MS: "150000",
    MAX_BODY_BYTES: "1048576",
    MAX_RESPONSE_BYTES: "2097152",
    LOG_BODY_MAX_BYTES: "4096",
    MAX_LOG_ENTRIES: "250",
    MODELS_CACHE_TTL_HOURS: "12",
  });

  assert.equal(config.ADMIN_PORT, 9109);
  assert.equal(config.API_PORT, 9108);
  assert.equal(config.REQUEST_TIMEOUT_MS, 150_000);
  assert.equal(config.MAX_BODY_BYTES, 1_048_576);
  assert.equal(config.MAX_RESPONSE_BYTES, 2_097_152);
  assert.equal(config.LOG_BODY_MAX_BYTES, 4_096);
  assert.equal(config.MAX_LOG_ENTRIES, 250);
  assert.equal(config.MODELS_CACHE_TTL_MS, 12 * 60 * 60 * 1000);
});
