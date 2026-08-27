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
let recoveryCode;
let serviceLog = "";

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

async function waitForLog(pattern, from = 0) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const match = pattern.exec(serviceLog.slice(from));
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("expected service log entry was not emitted");
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
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { serviceLog += chunk.toString(); });
  child.stderr.on("data", (chunk) => { serviceLog += chunk.toString(); });
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
  const mismatch = await request(adminPort, "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "testpass123", passwordConfirmation: "different-password" }),
  });
  assert.equal(mismatch.status, 400);
  assert.match(mismatch.body, /confirmation/);

  const setup = await request(adminPort, "/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "testpass123", passwordConfirmation: "testpass123" }),
  });
  assert.equal(setup.status, 201);

  const signin = await request(adminPort, "/");
  assert.match(signin.body, /Forgot password/);

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
  assert.match(asset.headers["cache-control"], /private/);
  assert.ok(asset.headers.etag);

  const revalidatedAsset = await request(adminPort, "/dashboard.js", {
    headers: { cookie: adminCookie, "if-none-match": asset.headers.etag },
  });
  assert.equal(revalidatedAsset.status, 304);
  assert.equal(revalidatedAsset.body, "");
  assert.equal(state.status, 200);
});


test("reads authenticated proxy request bodies before upstream selection", async () => {
  const createClient = await request(adminPort, "/api/admin/client-keys", {
    method: "POST",
    headers: { cookie: adminCookie, "x-csrf-token": csrfToken, "content-type": "application/json" },
    body: JSON.stringify({ label: "Body reader test" }),
  });
  assert.equal(createClient.status, 201);
  const clientApiKey = JSON.parse(createClient.body).clientApiKey;

  const proxied = await request(apiPort, "/v1beta/models/gemini-test:generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": clientApiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: "body reader regression test" }] }] }),
  });
  assert.equal(proxied.status, 503);
  assert.match(proxied.body, /No Gemini API keys/);
});

test("serves the complete authenticated dashboard panel set", async () => {
  const panels = ["overview", "gemini-keys", "client-keys", "request-logs", "statistics"];
  const responses = await Promise.all(panels.map((panel) =>
    request(adminPort, "/panels/" + panel + ".html", { headers: { cookie: adminCookie } })
  ));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /html/);
  }
  const controllers = await Promise.all(["request-logs", "statistics"].map((panel) =>
    request(adminPort, "/panels/" + panel + ".js", { headers: { cookie: adminCookie } })
  ));
  for (const controller of controllers) {
    assert.equal(controller.status, 200);
    assert.match(controller.headers["content-type"], /javascript/);
  }
  const missing = await request(adminPort, "/panels/unknown.html", { headers: { cookie: adminCookie } });
  assert.equal(missing.status, 404);
  const missingController = await request(adminPort, "/panels/overview.js", { headers: { cookie: adminCookie } });
  assert.equal(missingController.status, 404);
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

  const fullUsage = await request(adminPort, "/api/admin/usage?period=all", { headers: { cookie: adminCookie } });
  const fullReport = JSON.parse(fullUsage.body);
  for (const field of ["clients", "keys", "models", "matrix_client", "matrix_gemini", "failures_model"]) {
    assert.ok(Array.isArray(fullReport[field]), "full usage response includes " + field);
  }
});

test("keeps the manual model refresh route available", async () => {
  const refresh = await request(adminPort, "/api/admin/models/refresh", {
    method: "POST",
    headers: { cookie: adminCookie, "x-csrf-token": csrfToken },
  });
  assert.equal(refresh.status, 502);
  assert.equal(JSON.parse(refresh.body).status, 503);
});


test("requires confirmation and deletes usage and request logs independently", async () => {
  const authHeaders = { cookie: adminCookie, "x-csrf-token": csrfToken, "content-type": "application/json" };
  const database = new DatabaseSync(path.join(dbDir, "test.db"));
  database.prepare("INSERT INTO usage (created_at,model,outcome,ok,status) VALUES (?,?,?,?,?)")
    .run(Date.now(), "delete-test", "success", 1, 200);
  database.prepare("INSERT INTO request_logs (created_at,model,outcome) VALUES (?,?,?)")
    .run(Date.now(), "delete-test", "success");
  database.close();

  const missingUsageConfirmation = await request(adminPort, "/api/admin/usage", {
    method: "DELETE", headers: authHeaders, body: JSON.stringify({}),
  });
  assert.equal(missingUsageConfirmation.status, 400);

  const deletedUsage = await request(adminPort, "/api/admin/usage", {
    method: "DELETE", headers: authHeaders, body: JSON.stringify({ confirm: "DELETE USAGE" }),
  });
  assert.equal(deletedUsage.status, 200);
  assert.ok(JSON.parse(deletedUsage.body).deleted >= 1);

  const deletedLogs = await request(adminPort, "/api/admin/logs", {
    method: "DELETE", headers: authHeaders, body: JSON.stringify({ confirm: "DELETE LOGS" }),
  });
  assert.equal(deletedLogs.status, 200);
  assert.ok(JSON.parse(deletedLogs.body).deleted >= 1);

  const usage = await request(adminPort, "/api/admin/usage?period=all&view=statistics", { headers: { cookie: adminCookie } });
  assert.deepEqual(JSON.parse(usage.body).models, []);
  const logs = await request(adminPort, "/api/admin/logs", { headers: { cookie: adminCookie } });
  assert.equal(JSON.parse(logs.body).total, 0);
});

test("resets the administrator password with a locally logged code", async () => {
  const resetPage = await request(adminPort, "/reset-password");
  assert.equal(resetPage.status, 200);
  assert.match(resetPage.body, /Recovery Code/);

  const beforeCodeLog = serviceLog.length;
  const codeRequest = await request(adminPort, "/api/password-reset-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin" }),
  });
  assert.equal(codeRequest.status, 202);
  recoveryCode = (await waitForLog(/Password reset code for 'admin': ([A-Za-z0-9_-]+)/, beforeCodeLog))[1];
  assert.match(recoveryCode, /^[A-Za-z0-9_-]{32}$/);

  const repeatedRequest = await request(adminPort, "/api/password-reset-code", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin" }),
  });
  assert.equal(repeatedRequest.status, 202);

  const mismatch = await request(adminPort, "/api/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", recoveryCode, password: "replacement123", passwordConfirmation: "different-password" }),
  });
  assert.equal(mismatch.status, 400);

  const rejected = await request(adminPort, "/api/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", recoveryCode: "wrong-code", password: "replacement123", passwordConfirmation: "replacement123" }),
  });
  assert.equal(rejected.status, 401);

  const reset = await request(adminPort, "/api/reset-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", recoveryCode, password: "replacement123", passwordConfirmation: "replacement123" }),
  });
  assert.equal(reset.status, 200);

  const staleSession = await request(adminPort, "/api/admin/state", { headers: { cookie: adminCookie } });
  assert.equal(staleSession.status, 401);

  const oldLogin = await request(adminPort, "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=testpass123",
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await request(adminPort, "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=replacement123",
  });
  assert.equal(newLogin.status, 302);
});
