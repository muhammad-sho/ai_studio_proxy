const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const http = require("node:http");
const net = require("node:net");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const root = path.resolve(__dirname, "..");
let adminPort;
let apiPort;
let dbDir;
let child;
let adminCookie;
let csrfToken;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, pathName, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || "";
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathName,
      method: options.method || "GET",
      headers: { ...(body ? { "content-length": Buffer.byteLength(body) } : {}), ...(options.headers || {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function waitForHealth(port) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const result = await request(port, "/health");
      if (result.status === 200) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error("server did not become healthy");
}

before(async () => {
  [adminPort, apiPort] = await Promise.all([freePort(), freePort()]);
  dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-studio-proxy-test-"));
  child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, ADMIN_PORT: String(adminPort), API_PORT: String(apiPort), DB_PATH: path.join(dbDir, "test.db") },
    stdio: "ignore",
  });
  await Promise.all([waitForHealth(adminPort), waitForHealth(apiPort)]);
});

after(async () => {
  if (child && !child.killed) child.kill("SIGTERM");
  await fs.rm(dbDir, { recursive: true, force: true });
});

test("keeps the admin and API port route families separate", async () => {
  const [adminApi, apiDashboard] = await Promise.all([
    request(adminPort, "/v1beta/models"),
    request(apiPort, "/"),
  ]);
  assert.equal(adminApi.status, 404);
  assert.match(adminApi.body, /Not found on this port/);
  assert.equal(apiDashboard.status, 404);
  assert.match(apiDashboard.body, /Not found on this port/);
});

test("requires authentication for dashboard assets and admin APIs", async () => {
  const [asset, state] = await Promise.all([
    request(adminPort, "/dashboard.js"),
    request(adminPort, "/api/admin/state"),
  ]);
  assert.equal(asset.status, 401);
  assert.equal(state.status, 401);
});

test("sets up an administrator and serves authenticated dashboard assets", async () => {
  const setup = await request(adminPort, "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "testpass123" }),
  });
  assert.equal(setup.status, 201);

  const login = await request(adminPort, "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=testpass123",
  });
  assert.equal(login.status, 302);
  adminCookie = login.headers["set-cookie"].map((value) => value.split(";")[0]).join("; ");
  csrfToken = /ai_studio_proxy_csrf=([^;]+)/.exec(adminCookie)?.[1];
  assert.ok(csrfToken);

  const [dashboard, asset, state] = await Promise.all([
    request(adminPort, "/", { headers: { cookie: adminCookie } }),
    request(adminPort, "/dashboard.js", { headers: { cookie: adminCookie } }),
    request(adminPort, "/api/admin/state", { headers: { cookie: adminCookie } }),
  ]);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /AI Studio Proxy/);
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"], /javascript/);
  assert.equal(state.status, 200);
});

test("retains historical usage when a Gemini key is deleted", async () => {
  const authHeaders = { cookie: adminCookie, "x-csrf-token": csrfToken, "content-type": "application/json" };
  const addGemini = await request(adminPort, "/api/admin/keys", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ label: "History test", key: "AIza-history-test-key" }),
  });
  assert.equal(addGemini.status, 201);

  const addClient = await request(adminPort, "/api/admin/client-keys", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ label: "History client" }),
  });
  assert.equal(addClient.status, 201);

  const beforeDelete = await request(adminPort, "/api/admin/state", { headers: { cookie: adminCookie } });
  const state = JSON.parse(beforeDelete.body);
  const geminiId = state.keys.find((key) => key.label === "History test").id;
  const clientId = state.clientKeys.find((key) => key.label === "History client").id;

  const database = new DatabaseSync(path.join(dbDir, "test.db"));
  database.prepare("INSERT INTO usage (created_at,model,client_key_id,gemini_key_id,outcome,ok,status,error_code) VALUES (?,?,?,?,?,?,?,?)")
    .run(Date.now(), "history-model", clientId, geminiId, "success", 1, 200, null);
  database.close();

  const deleted = await request(adminPort, "/api/admin/keys/" + geminiId, {
    method: "DELETE",
    headers: authHeaders,
  });
  assert.equal(deleted.status, 200);

  const usage = await request(adminPort, "/api/admin/usage?period=all&view=gemini", { headers: { cookie: adminCookie } });
  const report = JSON.parse(usage.body);
  assert.equal(report.keys.find((key) => key.id === geminiId)?.total, 1);
  assert.match(report.keys.find((key) => key.id === geminiId)?.label || "", /^\(deleted #/);
});
