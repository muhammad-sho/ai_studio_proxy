const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createUsage, routingBalanceScore } = require("../lib/usage");

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

test("keeps error logs for 7 days but trims success logs after 3 days", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE model_key_state (model TEXT, key_id INTEGER, cooldown_until INTEGER);
    CREATE TABLE request_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER, model TEXT, outcome TEXT);
  `);
  const usage = createUsage({
    prep: (sql) => db.prepare(sql),
    log: () => {},
    dbg: () => {},
    maskKey: (key) => key,
    LOG_BODY_MAX_BYTES: 1024,
    MAX_LOG_ENTRIES: 1000,
  });
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const insert = db.prepare("INSERT INTO request_logs (created_at,model,outcome) VALUES (?,?,?)");
  insert.run(now - 4 * day, "old-success", "success");
  insert.run(now - 2 * day, "new-success", "success");
  insert.run(now - 5 * day, "old-failed", "failed");
  insert.run(now - 5 * day, "old-rejected", "rejected");
  insert.run(now - 8 * day, "aged-failed", "failed");
  insert.run(now - 8 * day, "aged-success", "success");
  usage.sweepDailyReset();
  const remaining = db.prepare("SELECT model FROM request_logs ORDER BY model").all().map((row) => row.model);
  assert.deepEqual(remaining, ["new-success", "old-failed", "old-rejected"]);
  db.close();
});
