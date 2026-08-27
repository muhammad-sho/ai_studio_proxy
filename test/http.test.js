const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const { createHttpHelpers } = require("../lib/http");

function bodyReader(maxBodyBytes = 8) {
  return createHttpHelpers({ corsOrigin: "*", maxBodyBytes }).readBody;
}

test("rejects an aborted request body instead of leaving the handler pending", async () => {
  const request = new EventEmitter();
  const result = bodyReader()(request);
  request.emit("aborted");

  await assert.rejects(result, (error) => error.status === 400 && error.message === "Request body was aborted");
});

test("stops retaining chunks after the body limit is exceeded", async () => {
  const request = new EventEmitter();
  request.resumed = false;
  request.resume = () => { request.resumed = true; };
  const result = bodyReader(3)(request);
  request.emit("data", Buffer.from("four"));

  await assert.rejects(result, (error) => error.status === 413);
  assert.equal(request.resumed, true);
});
