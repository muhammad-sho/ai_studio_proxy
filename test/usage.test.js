const assert = require("node:assert/strict");
const { test } = require("node:test");
const { routingBalanceScore } = require("../lib/usage");

const keys = [{ id: 1 }, { id: 2 }];

test("reports a perfect routing balance when each key has equal model usage", () => {
  assert.equal(routingBalanceScore([
    { model: "flash", key_id: 1, today: 5 },
    { model: "flash", key_id: 2, today: 5 },
  ], keys), 100);
});

test("reports zero when one key handles all requests for a model", () => {
  assert.equal(routingBalanceScore([
    { model: "flash", key_id: 1, today: 10 },
  ], keys), 0);
});

test("treats the best possible low-volume distribution as balanced", () => {
  assert.equal(routingBalanceScore([
    { model: "flash", key_id: 1, today: 1 },
  ], keys), 100);
  assert.equal(routingBalanceScore([
    { model: "flash", key_id: 1, today: 2 },
    { model: "flash", key_id: 2, today: 1 },
  ], keys), 100);
  assert.equal(routingBalanceScore([
    { model: "flash", key_id: 1, today: 3 },
  ], [{ id: 1 }, { id: 2 }, { id: 3 }]), 0);
});


test("fills unused keys with zeroes and weights models by request volume", () => {
  assert.equal(routingBalanceScore([
    { model: "balanced", key_id: 1, today: 5 },
    { model: "balanced", key_id: 2, today: 5 },
    { model: "concentrated", key_id: 1, today: 10 },
  ], keys), 50);
});

test("returns no score before any multi-key traffic exists", () => {
  assert.equal(routingBalanceScore([], keys), null);
  assert.equal(routingBalanceScore([], [{ id: 1 }]), 100);
  assert.equal(routingBalanceScore([], []), null);
});
