const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 9009);
const DB_PATH = process.env.DB_PATH || "./ai-studio-proxy.db";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 50 * 1024 * 1024);
const MAX_RESPONSE_BYTES = Number(process.env.MAX_RESPONSE_BYTES || 50 * 1024 * 1024);
const TRANSIENT_COOLDOWN_SECONDS = 60;
const LOG_BODY_MAX_BYTES = Math.max(1024, Number(process.env.LOG_BODY_MAX_BYTES || 64 * 1024));
const MAX_LOG_ENTRIES = Math.max(50, Number(process.env.MAX_LOG_ENTRIES || 1000));
const MODELS_CACHE_TTL_MS = Number(process.env.MODELS_CACHE_TTL_HOURS || 24) * 60 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const loginFailures = [];
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || "");
const DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG || "");
const COOKIE_SESSION = "ai_studio_proxy_dashboard";
const COOKIE_CSRF = "ai_studio_proxy_csrf";

function log(level, category, message) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${category}] ${message}`;
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}
const dbg = (category, message) => { if (DEBUG) log("debug", category, message); };
const maskKey = (key) => `${String(key || "").slice(0, 6)}...`;

const db = new DatabaseSync(DB_PATH);
const preparedStatements = new Map();
function prep(sql) {
  let stmt = preparedStatements.get(sql);
  if (!stmt) preparedStatements.set(sql, (stmt = db.prepare(sql)));
  return stmt;
}
try { fs.chmodSync(DB_PATH, 0o600); } catch {}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
  DROP TABLE IF EXISTS requests;
  DROP TABLE IF EXISTS model_stats;
  CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    api_key TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS client_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    key_text TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS models (
    name TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS model_key_state (
    model TEXT NOT NULL,
    key_id INTEGER NOT NULL,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    cooldown_reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (model, key_id)
  );
  CREATE TABLE IF NOT EXISTS request_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    key_id INTEGER,
    key_label TEXT,
    key_masked TEXT,
    status INTEGER,
    outcome TEXT NOT NULL,
    error_code TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    trace_id TEXT,
    events TEXT,
    request_body TEXT,
    response_body TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_request_logs_created ON request_logs(created_at);
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    client_key_id INTEGER,
    gemini_key_id INTEGER,
    outcome TEXT NOT NULL,
    ok INTEGER NOT NULL,
    status INTEGER,
    error_code TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_usage_model_ok_time ON usage(model, ok, created_at, gemini_key_id);
  CREATE INDEX IF NOT EXISTS idx_usage_client_time ON usage(client_key_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_gemini_time ON usage(gemini_key_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);
  CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
function json(response, status, value) {
  if (response.writableEnded || response.destroyed) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function securityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, x-goog-api-key, x-proxy-api-key, x-goog-upload-offset, x-goog-upload-command, x-goog-upload-protocol, x-goog-upload-header-content-length, x-goog-upload-header-content-type, x-goog-upload-status");
  response.setHeader("Access-Control-Max-Age", "86400");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let failed = false;
    request.on("data", (chunk) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        failed = true;
        chunks.length = 0;
        request.resume();
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => { if (!failed) resolve(Buffer.concat(chunks)); });
    request.on("error", (error) => { if (!failed) { failed = true; reject(error); } });
  });
}

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left, right) {
  return crypto.timingSafeEqual(Buffer.from(hashValue(String(left)), "hex"), Buffer.from(hashValue(String(right)), "hex"));
}

function cookieValue(request, name) {
  return (request.headers.cookie || "").match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1] || null;
}

function sessionFromRequest(request) {
  const token = cookieValue(request, COOKIE_SESSION);
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; }
  return session;
}

function dashboardSessionValid(request) {
  return Boolean(sessionFromRequest(request));
}

function csrfValid(request) {
  const session = sessionFromRequest(request);
  const cookieToken = cookieValue(request, COOKIE_CSRF) || "";
  const headerToken = request.headers["x-csrf-token"] || "";
  return Boolean(session && cookieToken && headerToken && constantTimeEqual(cookieToken, headerToken) && constantTimeEqual(session.csrfToken, headerToken));
}

function resolveClientKey(request) {
  const query = new URL(request.url, "http://localhost").searchParams;
  const supplied = request.headers["x-proxy-api-key"] ||
    request.headers["x-goog-api-key"] ||
    query.get("key") || "";
  if (!supplied) return null;
  return prep("SELECT id, label FROM client_keys WHERE key_hash = ?").get(hashValue(supplied)) || null;
}

function localKeyIsValid(request) {
  return Boolean(resolveClientKey(request));
}

function clientAddress(request) {
  if (TRUST_PROXY) {
    const forwarded = request.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",").pop().trim() || "unknown";
  }
  return request.socket.remoteAddress || "unknown";
}

function requestPath(request) {
  try { return new URL(request.url, "http://localhost").pathname; } catch { return request.url.split("?")[0]; }
}

function pruneLoginAttempts() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [address, attempts] of loginAttempts) {
    const recent = attempts.filter((time) => time > cutoff);
    if (recent.length) loginAttempts.set(address, recent);
    else loginAttempts.delete(address);
  }
  while (loginFailures.length && loginFailures[0] <= cutoff) loginFailures.shift();
}

let globalCapLoggedAt = 0;
function rateLimited(address) {
  const now = Date.now();
  const recent = (loginAttempts.get(address) || []).filter((time) => time > now - 15 * 60 * 1000);
  loginAttempts.set(address, recent);
  pruneLoginAttempts();
  if (recent.length >= 10) return true;
  if (loginFailures.length >= 1000) {
    if (now - globalCapLoggedAt > 60_000) {
      globalCapLoggedAt = now;
      log("warn", "Auth", `global failure cap reached (${loginFailures.length} failures in window); rejecting logins from all addresses`);
    }
    return true;
  }
  return false;
}

function recordLoginFailure(address) {
  const recent = loginAttempts.get(address) || [];
  recent.push(Date.now());
  loginAttempts.set(address, recent);
  loginFailures.push(Date.now());
}

const allowedLabelTables = new Set(["client_keys", "api_keys"]);
function nextAutoLabel(table, prefix) {
  if (!allowedLabelTables.has(table)) throw new Error("invalid table for auto-label");
  let max = 0;
  for (const row of db.prepare(`SELECT label FROM ${table}`).all()) {
    const match = String(row.label).match(`^${prefix}(\\d+)$`);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}${max + 1}`;
}

function hasAdmin() {
  return Boolean(prep("SELECT id FROM admin_users LIMIT 1").get());
}

function passwordDigest(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString("hex"));
    });
  });
}

async function passwordValid(password, user) {
  const actual = Buffer.from(await passwordDigest(password, user.password_salt), "hex");
  const expected = Buffer.from(user.password_hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createClientKey(label) {
  const value = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO client_keys (label,key_hash,key_prefix,key_text,created_at) VALUES (?,?,?,?,?)")
    .run(label, hashValue(value), `${value.slice(0, 8)}...`, value, Date.now());
  invalidateSecretMaskCache();
  return value;
}

const setupPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Studio Proxy Setup</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:#f8fafc;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#ffffff;border:1px solid #e2e8f0;border-radius: 0;padding:32px;width:100%;max-width:440px;box-shadow:0 4px 12px rgba(0,0,0,0.05)}.brand{display:flex;align-items:center;gap:10px;margin-bottom:20px}.badge{width:32px;height:32px;background:#0f172a;color:#fff;border-radius: 0;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center}h1{font-size:20px;font-weight:800;letter-spacing:-0.02em}p{font-size:13px;color:#64748b;margin-bottom:20px;line-height:1.5}label{display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:6px}input{font-family:inherit;font-size:14px;width:100%;padding:10px 14px;border:1px solid #cbd5e1;border-radius: 0;outline:none;margin-bottom:14px}input:focus{border-color:#0f172a}button{font-family:inherit;font-size:14px;font-weight:700;width:100%;padding:12px;border:none;border-radius: 0;background:#0f172a;color:#fff;cursor:pointer;transition:background .15s}button:hover{background:#334155}a{color:#0f172a;font-weight:700;text-decoration:none}a:hover{text-decoration:underline}</style></head><body><div class="card"><div class="brand"><div class="badge">AS</div><h1>First-Time Setup</h1></div><p>Create the administrator account for this dashboard.</p><form id="setup"><label>Admin Username</label><input name="username" placeholder="Username" required><label>Admin Password</label><input name="password" type="password" minlength="8" placeholder="Password (8+ chars)" required><button>Create Administrator Account</button></form><div id="result"></div></div><script>setup.onsubmit=async e=>{e.preventDefault();let f=new FormData(e.target);let r=await fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:f.get('username'),password:f.get('password')})});let d=await r.json();if(!r.ok)return alert(d.error);result.innerHTML='<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0"><p style="color:#0f172a;font-weight:700;margin-bottom:4px">Administrator account created.</p><p>Add your Gemini API keys to start proxying requests.</p><p style="margin-top:12px"><a href="/">Continue to Sign In &rarr;</a></p></div>';e.target.remove()}</script></body></html>`;

const PASS_THROUGH_ACTIONS = new Set(["generateContent", "streamGenerateContent", "countTokens", "embedContent", "batchEmbedContents", "asyncBatchEmbedContent", "predict", "predictLongRunning"]);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer"]);

function parseApiRoute(pathname) {
  const match = pathname.match(/^\/(?:v1alpha|v1beta|v1)(\/.*)$/);
  if (!match) return null;
  let rest;
  try { rest = decodeURIComponent(match[1]); } catch { return null; }
  const modelAction = rest.match(/^\/models\/([^/:]+):([A-Za-z]+)$/);
  if (modelAction) return { model: modelAction[1], action: modelAction[2] };
  return { model: null, action: null, subpath: rest };
}

function parseUploadRoute(pathname) {
  const match = pathname.match(/^\/upload\/(v1alpha|v1beta|v1)(\/.*)$/);
  if (!match) return null;
  return { version: match[1], subpath: match[2] };
}

function filterResponseHeaders(upstreamHeaders) {
  const headers = {};
  for (const [name, value] of Object.entries(upstreamHeaders || {})) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

function rewriteUploadUrl(uploadUrl, request) {
  try {
    const host = request.headers["x-forwarded-host"] || request.headers.host || "localhost";
    const proto = request.headers["x-forwarded-proto"] || "https";
    const u = new URL(uploadUrl);
    u.hostname = host.split(":")[0];
    u.port = host.includes(":") ? host.split(":")[1] : "";
    u.protocol = proto + ":";
    return u.toString();
  } catch { return uploadUrl; }
}

function statsModelName(model, action, fallbackPath) {
  if (!model) return fallbackPath || "api";
  return PASS_THROUGH_ACTIONS.has(action || "") ? model : `${model}:${action}`;
}

function poolKeys() {
  return prep("SELECT id, api_key FROM api_keys ORDER BY id").all();
}

function setMeta(key, value) {
  db.prepare("INSERT INTO app_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));
}

function getMeta(key) {
  return db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key)?.value || null;
}

function laOffsetMinutes(at) {
  const offsetPart = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", timeZoneName: "longOffset",
  }).formatToParts(new Date(at)).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
  const offsetMatch = offsetPart.match(/GMT([+-])(\d{2}):(\d{2})/);
  return offsetMatch
    ? (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) * (offsetMatch[1] === "+" ? 1 : -1)
    : 0;
}

function laDayStartUtc(year, monthIndex0, day) {
  const naive = Date.UTC(year, monthIndex0, day);
  return naive - laOffsetMinutes(naive + 12 * 60 * 60 * 1000) * 60_000;
}

function pacificDayStart(now = Date.now()) {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  return laDayStartUtc(Number(values.year), Number(values.month) - 1, Number(values.day));
}

function pacificMonthString(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function laDayStartUtcOfDaysAgo(days) {
  return laDayStartUtc(...(function () {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
    const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
    return [Number(v.year), Number(v.month) - 1, Number(v.day)];
  })());
}

function pacificMonthRange(month) {
  const [year, month1] = month.split("-").map(Number);
  const start = laDayStartUtc(year, month1 - 1, 1);
  const end = month1 === 12 ? laDayStartUtc(year + 1, 0, 1) : laDayStartUtc(year, month1, 1);
  return [start, end];
}

function usageStats() {
  const start = pacificDayStart();
  return prep(`
    SELECT m.name AS model, k.id AS key_id, k.label,
           substr(k.api_key, 1, 6) || '...' AS masked,
           COUNT(u.id) AS today, MAX(u.created_at) AS last_request,
           COALESCE(s.cooldown_until, 0) AS cooldown_until,
           COALESCE(s.cooldown_reason, '') AS cooldown_reason
    FROM (SELECT name FROM models
          UNION SELECT DISTINCT model AS name FROM usage WHERE ok = 1 AND created_at >= ?
          UNION SELECT DISTINCT model AS name FROM model_key_state) m
    CROSS JOIN (SELECT id, label, api_key FROM api_keys) k
    LEFT JOIN usage u ON u.model = m.name AND u.gemini_key_id = k.id AND u.ok = 1 AND u.created_at >= ?
    LEFT JOIN model_key_state s ON s.model = m.name AND s.key_id = k.id
    GROUP BY m.name, k.id, k.label, k.api_key, s.cooldown_until, s.cooldown_reason
    HAVING today > 0 OR cooldown_until > ?
    ORDER BY m.name, k.id
  `).all(start, start, Date.now());
}

let secretMaskCache = null;
function invalidateSecretMaskCache() { secretMaskCache = null; }
function maskSecrets(text) {
  if (!secretMaskCache) {
    secretMaskCache = [];
    for (const row of prep("SELECT api_key FROM api_keys").all()) secretMaskCache.push([row.api_key, maskKey(row.api_key)]);
    for (const row of prep("SELECT key_text FROM client_keys WHERE key_text IS NOT NULL").all()) secretMaskCache.push([row.key_text, maskKey(row.key_text)]);
  }
  let out = String(text);
  for (const [secret, masked] of secretMaskCache) out = out.split(secret).join(masked);
  return out;
}

function clipBody(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value || "");
  return text.length > LOG_BODY_MAX_BYTES ? text.slice(0, LOG_BODY_MAX_BYTES) + "...[truncated]" : text;
}

function upstreamErrorPayload(body) {
  try { return JSON.parse(body.toString("utf8")).error || {}; } catch { return null; }
}
function errorCodeFromPayload(error) {
  if (!error) return null;
  return String(error.status || error.code || error.message || "").slice(0, 120) || null;
}

function recordLog(entry) {
  try {
    prep("INSERT INTO request_logs (created_at,model,key_id,key_label,key_masked,status,outcome,error_code,attempt,trace_id,events,request_body,response_body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(Date.now(), entry.model, entry.keyId ?? null, entry.keyLabel ?? null, entry.keyMasked ?? null,
        entry.status ?? null, entry.outcome, entry.errorCode ? maskSecrets(String(entry.errorCode)) : null, entry.attempt ?? 0,
        entry.traceId ?? null,
        Array.isArray(entry.events) ? maskSecrets(JSON.stringify(entry.events)) : null,
        entry.requestBody === undefined ? null : maskSecrets(clipBody(entry.requestBody)),
        entry.responseBody === undefined ? null : maskSecrets(clipBody(entry.responseBody)));
  } catch (error) {
    log("error", "Log", `failed to record request log: ${error.message}`);
  }
}

const REQUEST_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function recordUsageRow(model, clientKeyId, geminiKeyId, outcome, ok, status, errorCode) {
  try {
    prep("INSERT INTO usage (created_at,model,client_key_id,gemini_key_id,outcome,ok,status,error_code) VALUES (?,?,?,?,?,?,?,?)")
      .run(Date.now(), model, clientKeyId ?? null, geminiKeyId ?? null, outcome, ok ? 1 : 0, status ?? null, errorCode ?? null);
  } catch (error) {
    log("error", "Usage", `failed to record usage row: ${error.message}`);
  }
}

let lastSweptUsageDay = null;
function sweepDailyReset() {
  const today = pacificDayStart();
  if (lastSweptUsageDay !== null && today !== lastSweptUsageDay) {
    log("info", "Usage", "Pacific midnight reset - cleared previous day's usage and expired cooldowns");
  }
  lastSweptUsageDay = today;
  const purgedCooldowns = prep("DELETE FROM model_key_state WHERE cooldown_until <= ?").run(Date.now()).changes;
  const purgedLogs = prep("DELETE FROM request_logs WHERE id <= (SELECT id FROM request_logs ORDER BY id DESC LIMIT 1 OFFSET ?)").run(MAX_LOG_ENTRIES).changes;
  const purgedAgedLogs = prep("DELETE FROM request_logs WHERE created_at < ?").run(Date.now() - REQUEST_LOG_RETENTION_MS).changes;
  if (purgedCooldowns || purgedLogs || purgedAgedLogs) dbg("Usage", `sweep removed ${purgedCooldowns} expired cooldown(s), ${purgedLogs} excess log entr(ies), ${purgedAgedLogs} aged log entr(ies)`);
}

function setCooldownUntil(model, keyId, timestamp, reason) {
  prep("INSERT INTO model_key_state (model,key_id,cooldown_until,cooldown_reason) VALUES (?,?,?,?) ON CONFLICT(model,key_id) DO UPDATE SET cooldown_until=excluded.cooldown_until,cooldown_reason=excluded.cooldown_reason")
    .run(model, keyId, timestamp, reason);
}

function setCooldown(model, keyId, seconds, reason) {
  setCooldownUntil(model, keyId, Date.now() + Math.max(0, seconds) * 1000, reason);
}

function nextPacificReset(now = Date.now()) {
  return pacificDayStart(pacificDayStart(now) + 36 * 60 * 60 * 1000);
}

function forwardToGemini(context, body, key, opts = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const incomingUrl = new URL(context.url, "http://localhost");
    const upstreamUrl = new URL("https://generativelanguage.googleapis.com");
    upstreamUrl.pathname = incomingUrl.pathname;
    upstreamUrl.search = incomingUrl.search;
    if (upstreamUrl.searchParams.has("key")) upstreamUrl.searchParams.set("key", key);
    const droppedHeaders = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade",
      "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer",
      "authorization", "cookie", "content-length", "x-goog-api-key", "x-proxy-api-key"]);
    const headers = {};
    for (const [name, value] of Object.entries(context.headers || {})) {
      const lower = name.toLowerCase();
      if (!droppedHeaders.has(lower) && !lower.startsWith("proxy-")) headers[name] = value;
    }
    headers["content-length"] = body.length;
    headers["x-goog-api-key"] = key;
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const clientResponse = opts.clientResponse;
    const timeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, Number(opts.timeoutMs) || REQUEST_TIMEOUT_MS));
    const upstreamRequest = https.request({
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || 443,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      method: context.method || "GET",
      timeout: timeoutMs,
      headers,
    }, (response) => {
      dbg("Upstream", `[${(opts.traceId || "").slice(0, 8)}] key ${maskKey(key)} -> ${context.method || "GET"} ${upstreamUrl.pathname} started (timeout ${timeoutMs}ms)`);
      if (opts.stream && response.statusCode >= 200 && response.statusCode < 300 &&
          String(response.headers["content-type"] || "").includes("event-stream")) {
        finish(resolve, { stream: true, status: response.statusCode, headers: response.headers, response });
        return;
      }
      const chunks = [];
      let bytes = 0;
      let tooLarge = false;
      let complete = false;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else tooLarge = true;
      });
      response.on("end", () => {
        complete = true;
        if (tooLarge) return finish(reject, Object.assign(new Error("Gemini response is too large"), { status: 502 }));
        dbg("Upstream", `key ${maskKey(key)} <- ${response.statusCode} (${Date.now() - startedAt}ms, ${Buffer.concat(chunks).length} bytes)`);
        finish(resolve, {
          status: response.statusCode || 502,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
      response.on("aborted", () => finish(reject, Object.assign(new Error("Upstream connection aborted mid-response"), { status: 502 })));
      response.on("error", (error) => finish(reject, error));
      response.on("close", () => {
        if (!complete) finish(reject, Object.assign(new Error("Upstream closed before completing the response"), { status: 502 }));
      });
    });
    if (clientResponse) {
      clientResponse.on("close", () => {
        if (!clientResponse.writableEnded && !settled) upstreamRequest.destroy(new Error("Client disconnected"));
      });
    }
    upstreamRequest.on("timeout", () => upstreamRequest.destroy(new Error("Gemini request timed out")));
    upstreamRequest.on("error", (error) => finish(reject, error));
    upstreamRequest.end(body);
  });
}

function contextFromRequest(request) {
  return { url: request.url, method: request.method, headers: request.headers };
}

function returnUpstream(response, result, request) {
  if (response.writableEnded || response.destroyed) return;
  const headers = filterResponseHeaders(result.headers);
  if (request && headers["x-goog-upload-url"]) {
    headers["x-goog-upload-url"] = rewriteUploadUrl(headers["x-goog-upload-url"], request);
  }
  response.writeHead(result.status, headers);
  return response.end(result.body);
}

function classifyUpstream(status, error) {
  error = error || {};
  const message = `${error.status || ""} ${error.code || ""} ${error.message || ""}`.toLowerCase();
  if (message.includes("api_key_invalid") || message.includes("invalid api key") || status === 401) return "invalid_key";
  const detailsText = JSON.stringify(error.details || []).toLowerCase();
  if (/\b(per[_ ]?day|daily|requests per day|\brpd\b)\b/.test(message) || detailsText.includes("perday") || detailsText.includes("per_day")) return "daily_quota";
  if ([408, 429, 500, 502, 503, 504].includes(status)) return "transient";
  return "permanent";
}


function hasQuotaDetails(error) {
  return error ? JSON.stringify(error.details || []).includes("quotaId") : false;
}

function syncModelsFromGemini(result) {
  let payload;
  try { payload = JSON.parse(result.body.toString("utf8")); } catch { return false; }
  if (!Array.isArray(payload.models)) return false;
  const names = [...new Set(payload.models
    .map((model) => String(model.name || "").replace(/^models\//, "").trim())
    .filter(Boolean))];
  if (!names.length) return false;
  const insert = db.prepare("INSERT INTO models (name) VALUES (?) ON CONFLICT(name) DO NOTHING");
  for (const name of names) insert.run(name);
  const placeholders = names.map(() => "?").join(",");
  db.prepare(`DELETE FROM models WHERE name NOT IN (${placeholders})`).run(...names);
  return true;
}

function buildModelsPayload(allModels) {
  const seen = new Set();
  const models = [];
  for (const model of allModels) {
    const name = String(model?.name || "").replace(/^models\//, "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    models.push({ ...model, name });
  }
  models.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { models };
}

let modelsRefreshInFlight = null;
function refreshModelsOnce(context) {
  if (!modelsRefreshInFlight) {
    modelsRefreshInFlight = refreshModels(context).finally(() => { modelsRefreshInFlight = null; });
  }
  return modelsRefreshInFlight;
}

async function refreshModels(context) {
  const keys = poolKeys();
  log("info", "Models", `sync started: trying ${keys.length} key(s) in order`);
  let lastResult = null;
  for (const key of keys) {
    let result;
    try {
      result = await forwardToGemini(context, Buffer.alloc(0), key.api_key);
    } catch (error) {
      log("warn", "Models", `key ${maskKey(key.api_key)} transport failure: ${error.message}`);
      continue;
    }
    lastResult = lastResult || result;
    if (result.status < 200 || result.status >= 300) {
      log("warn", "Models", `key ${maskKey(key.api_key)} returned ${result.status}; trying next`);
      continue;
    }
    let payload;
    try { payload = JSON.parse(result.body.toString("utf8")); } catch { payload = null; }
    if (!payload || !Array.isArray(payload.models)) {
      log("error", "Models", `key ${maskKey(key.api_key)}: 200 but body is not a models list (first bytes: ${result.body.subarray(0, 40).toString("hex")})`);
      continue;
    }
    const allModels = [...payload.models];
    let pageToken = payload.nextPageToken;
    for (let page = 0; page < 20 && pageToken; page += 1) {
      const pageUrl = new URL(context.url, "http://localhost");
      pageUrl.searchParams.set("pageToken", pageToken);
      const pageResult = await forwardToGemini({ url: pageUrl.pathname + pageUrl.search, method: "GET", headers: {} }, Buffer.alloc(0), key.api_key);
      if (pageResult.status < 200 || pageResult.status >= 300) break;
      let pagePayload;
      try { pagePayload = JSON.parse(pageResult.body.toString("utf8")); } catch { break; }
      if (!pagePayload || !Array.isArray(pagePayload.models)) break;
      allModels.push(...pagePayload.models);
      pageToken = pagePayload.nextPageToken;
    }
    const models = buildModelsPayload(allModels);
    if (!models.models.length) {
      log("warn", "Models", `key ${maskKey(key.api_key)} produced an empty model list; trying next`);
      continue;
    }
    setMeta("models_cache", JSON.stringify(models));
    setMeta("models_checked_at", Date.now());
    syncModelsFromGemini({ body: Buffer.from(JSON.stringify(models)) });
    log("info", "Models", `sync succeeded via key ${maskKey(key.api_key)}: ${models.models.length} models cached`);
    return result;
  }
  log("error", "Models", `sync failed on all ${keys.length} key(s)`);
  return lastResult || { status: 503, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "No Gemini API keys" })) };
}

function syntheticModelsRequest() {
  return { url: "/v1beta/models?pageSize=1000", method: "GET", headers: {} };
}

async function handleModelsList(request, response) {
  let cached = null;
  try { cached = JSON.parse(getMeta("models_cache") || "null"); } catch {}
  const checkedAt = Number(getMeta("models_checked_at") || 0);
  if (cached && Array.isArray(cached.models) && cached.models.length) {
    if (Date.now() - checkedAt >= MODELS_CACHE_TTL_MS) {
      log("info", "Models", `cache stale (age ${Math.round((Date.now() - checkedAt) / 60000)}min > TTL); serving cached list and refreshing in background`);
      refreshModelsOnce(syntheticModelsRequest()).catch((error) => log("error", "Models", `background refresh failed: ${error.message}`));
    } else {
      dbg("Models", `cache hit (${cached.models.length} models, age ${Math.round((Date.now() - checkedAt) / 60000)}min)`);
    }
    return json(response, 200, cached);
  }
  // Fallback: cache missing but models table has data — rebuild from DB and
  // serve instantly while a real refresh runs in the background.
  const dbModels = db.prepare("SELECT name FROM models ORDER BY name").all();
  if (dbModels.length) {
    log("info", "Models", `cache empty but ${dbModels.length} known models in database; serving DB fallback and refreshing in background`);
    const payload = { models: dbModels.map(m => ({ name: m.name })) };
    setMeta("models_cache", JSON.stringify(payload));
    setMeta("models_checked_at", Date.now());
    refreshModelsOnce(syntheticModelsRequest()).catch((error) => log("error", "Models", `background refresh failed: ${error.message}`));
    return json(response, 200, payload);
  }
  log("info", "Models", `no cache and no known models; blocking on upstream sync`);
  return returnUpstream(response, await refreshModelsOnce(contextFromRequest(request)), request);
}

async function handleGeminiPassthrough(request, response, model, action) {
  const modelName = statsModelName(model, action, requestPath(request));
  const startedAt = Date.now();
  const traceId = crypto.randomUUID();
  const short = traceId.slice(0, 8);
  const events = [];
  const mark = (type, detail) => events.push({ t: Date.now() - startedAt, type, detail });

  mark("receive", `${request.method} ${requestPath(request)} from ${clientAddress(request)}`);
  const clientKey = resolveClientKey(request);
  if (!clientKey) {
    log("warn", "Auth", `[${short}] rejected ${request.method} ${requestPath(request)}: invalid client key from ${clientAddress(request)}`);
    mark("reject", "invalid client API key");
    recordLog({ model: modelName, traceId, events, status: 401, outcome: "rejected", errorCode: "INVALID_CLIENT_KEY" });
    return json(response, 401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid proxy API key" } });
  }
  mark("auth", "client key accepted");

  let body;
  try { body = await readBody(request); } catch (error) {
    mark("reject", `request body could not be read: ${error.message}`);
    recordLog({ model: modelName, traceId, events, status: error.status || 400, outcome: "rejected", errorCode: "BODY_READ_FAILED" });
    return json(response, error.status || 400, { error: error.message });
  }
  mark("body", `${Buffer.byteLength(body)} byte request body`);

  const everyKey = prep("SELECT * FROM api_keys ORDER BY id").all();
  if (!everyKey.length) {
    log("warn", "Gemini", `[${short}] ${modelName}: request rejected, no Gemini API keys configured`);
    mark("reject", "no Gemini API keys configured");
    recordLog({ model: modelName, traceId, events, status: 503, outcome: "rejected", errorCode: "NO_KEYS_CONFIGURED" });
    return json(response, 503, { error: { code: 503, status: "UNAVAILABLE", message: "No Gemini API keys are configured" } });
  }
  const usage = prep("SELECT gemini_key_id AS key_id, COUNT(*) AS count FROM usage WHERE model = ? AND ok = 1 AND created_at >= ? GROUP BY gemini_key_id")
    .all(modelName, pacificDayStart()).reduce((map, row) => map.set(row.key_id, row.count), new Map());
  const coolingRows = new Map(prep("SELECT key_id, cooldown_until, cooldown_reason FROM model_key_state WHERE model = ?")
    .all(modelName).filter((row) => row.cooldown_until > Date.now()).map((row) => [row.key_id, row]));
  for (const key of everyKey) {
    const cd = coolingRows.get(key.id);
    key.rank = cd ? 1 : 0;
    key.until = cd ? cd.cooldown_until : 0;
    key.reason = cd ? cd.cooldown_reason : null;
  }
  everyKey.sort((left, right) => left.rank - right.rank || left.until - right.until || (usage.get(left.id) || 0) - (usage.get(right.id) || 0) || left.id - right.id);
  const readyCount = everyKey.filter((key) => key.rank === 0).length;
  dbg("Gemini", `[${short}] ${modelName}: ${readyCount} ready key(s), ${everyKey.length - readyCount} cooling down`);
  dbg("Gemini", `[${short}] ${modelName}: preference order ${everyKey.map((key) => `#${key.id}(${maskKey(key.api_key)}${key.rank === 1 ? `, ${key.reason}, ~${Math.max(0, Math.ceil((key.until - Date.now()) / 1000))}s left` : ""})`).join(" -> ")}`);
  mark("pool", `${everyKey.length} Gemini key(s); ready now: ${readyCount}`);
  mark("order", `preference ${everyKey.map((key) => `#${key.id}${key.rank === 1 ? ` (cooling: ${key.reason})` : ""}`).join(" > ")}`);
  const selected = everyKey[0];
  const upstreamContext = { url: request.url, method: request.method, headers: request.headers };
  if (selected.rank === 1) {
    log("warn", "Gemini", `[${short}] ${modelName}: all keys are cooling down; using key #${selected.id} (${selected.reason}, ~${Math.max(0, Math.ceil((selected.until - Date.now()) / 1000))}s left)`);
  }
  log("info", "Gemini", `[${short}] ${modelName}: using key #${selected.id} ${maskKey(selected.api_key)}`);
  mark("select", `key #${selected.id} "${selected.label}" ${maskKey(selected.api_key)} (${selected.rank === 1 ? `cooling: ${selected.reason}, ~${Math.max(0, Math.ceil((selected.until - Date.now()) / 1000))}s left` : "ready"}; ${usage.get(selected.id) || 0} success(es) today on this model)`);
  const callStartedAt = Date.now();
  try {
    const wantStream = (action || "").toLowerCase() === "streamgeneratecontent";
    const result = await forwardToGemini(upstreamContext, body, selected.api_key, { clientResponse: response, traceId, stream: wantStream });
    if (result.stream) {
      const outHeaders = filterResponseHeaders(result.headers);
      if (outHeaders["x-goog-upload-url"]) {
        outHeaders["x-goog-upload-url"] = rewriteUploadUrl(outHeaders["x-goog-upload-url"], request);
      }
      response.writeHead(result.status, outHeaders);
      mark("relay", `streaming Google's SSE response to the client (status ${result.status})`);
      recordUsageRow(modelName, clientKey.id, selected.id, "success", true, result.status, null);
      let captured = 0;
      const capturedChunks = [];
      let finalized = false;
      const finalize = () => {
        if (finalized) return;
        finalized = true;
        recordLog({
          model: modelName, traceId, events,
          keyId: selected.id, keyLabel: selected.label, keyMasked: maskKey(selected.api_key),
          status: result.status, outcome: "success", errorCode: null, attempt: 1,
          requestBody: body, responseBody: Buffer.concat(capturedChunks)
        });
        dbg("Gemini", `[${short}] stream finished (${captured} bytes relayed)`);
      };
      result.response.on("data", (chunk) => {
        if (captured < LOG_BODY_MAX_BYTES) { capturedChunks.push(chunk); captured += chunk.length; }
        if (!response.writableEnded && !response.destroyed && !response.write(chunk)) {
          result.response.pause();
          response.once("drain", () => result.response.resume());
        }
      });
      result.response.on("end", () => { response.end(); finalize(); });
      result.response.on("error", () => { response.destroy(); finalize(); });
      response.on("close", () => { if (!response.writableEnded) { mark("abort", "client disconnected during stream"); try { result.response.destroy(); } catch {} } });
      return;
    }
    const ok = result.status >= 200 && result.status < 300;
    const errorPayload = ok ? null : upstreamErrorPayload(result.body);
    const code = ok ? null : errorCodeFromPayload(errorPayload);
    mark("result", `key #${selected.id} <- Google responded ${result.status}${code ? ` (${code})` : ""} in ${Date.now() - callStartedAt}ms`);
    if (code) mark("upstream", `Google's response for key #${selected.id}, verbatim: ${clipBody(result.body)}`);
    const classification = classifyUpstream(result.status, errorPayload);
    let cooldownUntil = null;
    let cooldownReason = null;
    if (classification === "daily_quota") {
      cooldownUntil = nextPacificReset();
      cooldownReason = "daily_quota";
      log("warn", "Gemini", `[${short}] key #${selected.id} hit daily quota on ${modelName}; cooldown until Pacific midnight`);
      mark("cooldown", `key #${selected.id} benched until Pacific midnight (daily_quota)`);
    } else if (classification === "transient" || classification === "invalid_key") {
      const reason = classification === "invalid_key" ? "invalid_key" : (hasQuotaDetails(errorPayload) ? "high_demand" : "capacity");
      cooldownUntil = Date.now() + TRANSIENT_COOLDOWN_SECONDS * 1000;
      cooldownReason = reason;
      log("warn", "Gemini", `[${short}] key #${selected.id} got ${result.status} (${classification}/${reason}) on ${modelName}; cooldown ${TRANSIENT_COOLDOWN_SECONDS}s`);
      mark("cooldown", `key #${selected.id} benched ${TRANSIENT_COOLDOWN_SECONDS}s (${reason})`);
    }
    mark("relay", `relaying Google's response as-is to the client (status ${result.status})`);
    try {
      db.exec("BEGIN");
      prep("INSERT INTO usage (created_at,model,client_key_id,gemini_key_id,outcome,ok,status,error_code) VALUES (?,?,?,?,?,?,?,?)")
        .run(Date.now(), modelName, clientKey.id, selected.id, ok ? "success" : "failed", ok ? 1 : 0, result.status, ok ? null : (code || `HTTP_${result.status}`));
      if (cooldownUntil !== null) prep("INSERT INTO model_key_state (model,key_id,cooldown_until,cooldown_reason) VALUES (?,?,?,?) ON CONFLICT(model,key_id) DO UPDATE SET cooldown_until=excluded.cooldown_until,cooldown_reason=excluded.cooldown_reason")
        .run(modelName, selected.id, cooldownUntil, cooldownReason);
      prep("INSERT INTO request_logs (created_at,model,key_id,key_label,key_masked,status,outcome,error_code,attempt,trace_id,events,request_body,response_body) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(Date.now(), modelName, selected.id, selected.label, maskKey(selected.api_key),
          result.status,
          ok ? "success" : "failed",
          code ? maskSecrets(String(code)) : null, 1, traceId,
          maskSecrets(JSON.stringify(events)),
          maskSecrets(clipBody(body)), maskSecrets(clipBody(result.body)));
      db.exec("COMMIT");
    } catch (txError) {
      try { db.exec("ROLLBACK"); } catch {}
      log("error", "Log", `failed to persist request bookkeeping: ${txError.message}`);
    }
    return returnUpstream(response, result, request);
  } catch (error) {
    log("warn", "Gemini", `[${short}] key #${selected.id} transport failure on ${modelName}: ${error.message}`);
    mark("transport", `key #${selected.id} transport failure after ${Date.now() - callStartedAt}ms: ${error.message}`);
    setCooldown(modelName, selected.id, TRANSIENT_COOLDOWN_SECONDS, "upstream_error");
    mark("cooldown", `key #${selected.id} benched ${TRANSIENT_COOLDOWN_SECONDS}s (upstream_error)`);
    if (response.writableEnded || response.destroyed) {
      mark("abort", "client disconnected during the request");
      recordLog({
        model: modelName, traceId, events, attempt: 1,
        keyId: selected.id, keyLabel: selected.label, keyMasked: maskKey(selected.api_key),
        status: null, outcome: "aborted", errorCode: `transport: ${error.message}`.slice(0, 160), requestBody: body
      });
      return;
    }
  }
  log("error", "Gemini", `[${short}] ${modelName}: no upstream response`);
  mark("fail", "Google did not respond; proxy generated a 502");
  recordUsageRow(modelName, clientKey?.id, selected?.id, "failed", false, 502, "NO_UPSTREAM_RESPONSE");
  recordLog({ model: modelName, traceId, events, status: 502, outcome: "failed", errorCode: "NO_UPSTREAM_RESPONSE", attempt: 1, requestBody: body });
  return json(response, 502, { error: { code: 502, status: "BAD_GATEWAY", message: "Gemini did not respond on any attempted key" } });
}

const dashboardHtml = fs.readFileSync("dashboard.html", "utf8");
const dashboardGzip = zlib.gzipSync(dashboardHtml);

function sendDashboard(request, response) {
  if ((request.headers["accept-encoding"] || "").includes("gzip")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
    return response.end(dashboardGzip);
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  return response.end(dashboardHtml);
}

async function handleRequest(request, response) {
  securityHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (Number(request.headers["content-length"] || 0) > MAX_BODY_BYTES) {
    json(response, 413, { error: "Request body is too large" });
    request.resume();
    return;
  }
  if (url.pathname === "/health") return json(response, 200, { ok: true });
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    return response.end();
  }
  const uploadRoute = parseUploadRoute(url.pathname);
  if (uploadRoute) {
    return handleGeminiPassthrough(request, response, null, null);
  }
  const apiRoute = parseApiRoute(url.pathname);
  if (apiRoute && apiRoute.subpath === "/models" && ["GET", "POST"].includes(request.method)) {
    if (!localKeyIsValid(request)) {
      log("warn", "Auth", `rejected ${request.method} ${url.pathname}: invalid client key from ${clientAddress(request)}`);
      return json(response, 401, { error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid proxy API key" } });
    }
    return handleModelsList(request, response);
  }
  if (url.pathname === "/" && request.method === "GET") {
    if (!hasAdmin()) { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return response.end(setupPage); }
    if (!dashboardSessionValid(request)) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AI Studio Proxy Sign In</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet"><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:\'Plus Jakarta Sans\',system-ui,sans-serif;background:#f8fafc;color:#0f172a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#ffffff;border:1px solid #e2e8f0;border-radius: 0;padding:32px;width:100%;max-width:380px;box-shadow:0 4px 12px rgba(0,0,0,0.05)}.brand{display:flex;align-items:center;gap:10px;margin-bottom:8px}.badge{width:32px;height:32px;background:#0f172a;color:#fff;border-radius: 0;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center}h1{font-size:20px;font-weight:800;letter-spacing:-0.02em}p{font-size:13px;color:#64748b;margin-bottom:24px}label{display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:6px}input{font-family:inherit;font-size:14px;width:100%;padding:10px 14px;border:1px solid #cbd5e1;border-radius: 0;outline:none;margin-bottom:14px}input:focus{border-color:#0f172a}button{font-family:inherit;font-size:14px;font-weight:700;width:100%;padding:12px;border:none;border-radius: 0;background:#0f172a;color:#fff;cursor:pointer;margin-top:6px;transition:background .15s}button:hover{background:#334155}</style></head><body><div class="card"><div class="brand"><div class="badge">AS</div><h1>AI Studio Proxy</h1></div><p>Sign in to the admin dashboard</p><form method="post" action="/login"><label>Username</label><input name="username" placeholder="Username" required><label>Password</label><input name="password" type="password" placeholder="Password" required><button>Sign In</button></form></div></body></html>');
    }
    return sendDashboard(request, response);
  }
  if (url.pathname === "/api/setup" && request.method === "POST") {
    if (hasAdmin()) return json(response, 409, { error: "Setup is already complete" });
    if (rateLimited(clientAddress(request))) return json(response, 429, { error: "Too many setup attempts" });
    let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(String(body.username || ""))) return json(response, 400, { error: "Username must be 3-64 letters, numbers, _, ., or -" });
    if (String(body.password || "").length < 8) return json(response, 400, { error: "Password must be at least 8 characters" });
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await passwordDigest(String(body.password), salt);
    try {
      db.exec("BEGIN IMMEDIATE");
      if (hasAdmin()) { db.exec("ROLLBACK"); return json(response, 409, { error: "Setup is already complete" }); }
      db.prepare("INSERT INTO admin_users (username,password_hash,password_salt,created_at) VALUES (?,?,?,?)").run(String(body.username), passwordHash, salt, Date.now());
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      if (String(error.code || "").includes("CONSTRAINT")) return json(response, 409, { error: "Setup is already complete" });
      throw error;
    }
    return json(response, 201, { ok: true });
  }
  if (url.pathname === "/login" && request.method === "POST") {
    const address = clientAddress(request);
    if (rateLimited(address)) {
      log("warn", "Auth", `login rate-limited from ${address}`);
      return json(response, 429, { error: "Too many login attempts; try again later" });
    }
    let raw; try { raw = (await readBody(request)).toString(); } catch { return json(response, 400, { error: "Invalid request" }); }
    const body = Object.fromEntries(new URLSearchParams(raw));
    const username = String(body.username || "");
    let user = username ? db.prepare("SELECT * FROM admin_users WHERE username = ?").get(username) : null;
    if (!user) {
      // burn comparable CPU so unknown usernames are not distinguishable by response time
      await passwordValid(String(body.password || ""), { password_salt: "00000000000000000000000000000000", password_hash: "00".repeat(64) });
    }
    if (!user || !(await passwordValid(String(body.password || ""), user))) {
      log("warn", "Auth", `failed login for username '${username || "(empty)"}' from ${address}`);
      recordLoginFailure(address);
      return json(response, 401, { error: "Invalid username or password" });
    }
    loginAttempts.delete(address);
    const token = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, csrfToken });
    log("info", "Auth", `user '${username}' logged in from ${address} (session expires in ${SESSION_TTL_MS / 3600000}h)`);
    const secure = request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted ? "; Secure" : "";
    response.writeHead(302, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": [`${COOKIE_SESSION}=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`, `${COOKIE_CSRF}=${csrfToken}; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`] }); return response.end();
  }
  if (url.pathname === "/logout" && request.method === "POST") {
    if (!csrfValid(request)) return json(response, 403, { error: "Invalid CSRF token" });
    const token = cookieValue(request, COOKIE_SESSION);
    if (token) sessions.delete(token);
    log("info", "Auth", `user logged out`);
    response.writeHead(303, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": [`${COOKIE_SESSION}=; HttpOnly; SameSite=Strict; Max-Age=0`, `${COOKIE_CSRF}=; HttpOnly; SameSite=Strict; Max-Age=0`] });
    return response.end();
  }
  if (url.pathname.startsWith("/api/admin") && !dashboardSessionValid(request)) {
    if (!url.pathname.startsWith("/api/admin/state")) log("warn", "Auth", `rejected ${request.method} ${url.pathname}: no valid dashboard session`);
    return json(response, 401, { error: "Dashboard login required" });
  }
  if (url.pathname.startsWith("/api/admin") && request.method !== "GET" && !csrfValid(request)) {
    log("warn", "Auth", `rejected ${request.method} ${url.pathname}: invalid CSRF token`);
    return json(response, 403, { error: "Invalid CSRF token" });
  }
  if (url.pathname === "/api/admin/state" && request.method === "GET") {
    const keys = prep("SELECT id,label,substr(api_key,1,6)||'...' AS masked FROM api_keys ORDER BY id").all();
    const clientKeys = prep("SELECT id,label,key_prefix AS masked FROM client_keys ORDER BY id").all();
    const models = prep("SELECT name FROM models ORDER BY name").all();
    const cooldowns = prep("SELECT s.model, s.key_id AS keyId, k.label, substr(k.api_key,1,6)||'...' AS masked, s.cooldown_until AS until, s.cooldown_reason AS reason FROM model_key_state s JOIN api_keys k ON k.id = s.key_id WHERE s.cooldown_until > ? ORDER BY s.cooldown_until").all(Date.now());
    return json(response, 200, { keys, clientKeys, usage: usageStats(), resetAt: new Date(pacificDayStart()).toISOString(), resetTimezone: "America/Los_Angeles", modelsCheckedAt: getMeta("models_checked_at"), models, cooldowns });
  }
  if (url.pathname === "/api/admin/cooldowns/clear" && request.method === "POST") {
    const cleared = db.prepare("DELETE FROM model_key_state").run().changes;
    log("info", "Admin", `cleared all model/key cooldowns (${cleared} row(s))`);
    return json(response, 200, { ok: true, cleared });
  }
  if (url.pathname === "/api/admin/logs" && request.method === "GET") {
    const model = (url.searchParams.get("model") || "").trim();
    const outcome = (url.searchParams.get("outcome") || "").trim();
    const q = (url.searchParams.get("q") || "").trim();
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
    const where = [];
    const params = [];
    if (model) { where.push("model = ?"); params.push(model); }
    if (outcome) { where.push("outcome = ?"); params.push(outcome); }
    if (q) { where.push("(model LIKE ? ESCAPE '\\' OR IFNULL(key_label,'') LIKE ? ESCAPE '\\' OR IFNULL(error_code,'') LIKE ? ESCAPE '\\' OR IFNULL(CAST(status AS TEXT),'') LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`; params.push(like, like, like, like); }
    const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const logs = db.prepare(`SELECT id, created_at, model, key_label, key_masked, status, outcome, error_code, attempt, trace_id FROM request_logs${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS c FROM request_logs${whereSql}`).get(...params).c;
    const logModels = db.prepare("SELECT DISTINCT model FROM request_logs ORDER BY model").all().map(r => r.model);
    return json(response, 200, { logs, total, limit, offset, models: logModels });
  }
  const logMatch = url.pathname.match(/^\/api\/admin\/logs\/(\d+)$/);
  if (logMatch && request.method === "GET") {
    const entry = db.prepare("SELECT * FROM request_logs WHERE id = ?").get(Number(logMatch[1]));
    if (!entry) return json(response, 404, { error: "Log entry not found" });
    return json(response, 200, entry);
  }
  if (url.pathname === "/api/admin/usage" && request.method === "GET") {
    const allowedPeriods = new Set(["today", "7d", "30d", "month", "all"]);
    let period = url.searchParams.get("period") || "30d";
    const monthParam = url.searchParams.get("month") || "";
    if (!allowedPeriods.has(period)) period = "30d";
    let start = 0;
    let end = Number.MAX_SAFE_INTEGER;
    let scope;
    if (/^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) {
      [start, end] = pacificMonthRange(monthParam);
      scope = `month ${monthParam}`;
    } else if (period === "month") {
      [start, end] = pacificMonthRange(pacificMonthString());
      scope = `month ${pacificMonthString()}`;
    } else if (period === "today") {
      start = pacificDayStart();
      scope = "today (Pacific)";
    } else if (period === "7d") {
      start = laDayStartUtcOfDaysAgo(7);
      scope = "last 7 days";
    } else if (period === "30d") {
      start = laDayStartUtcOfDaysAgo(30);
      scope = "last 30 days";
    } else {
      scope = "all time";
    }
    const clients = prep(`SELECT u.client_key_id AS id, COALESCE(k.label, '(deleted #' || u.client_key_id || ')') AS label,
        COUNT(*) AS total, SUM(u.ok) AS success, COUNT(*) - SUM(u.ok) AS failed
      FROM usage u LEFT JOIN client_keys k ON k.id = u.client_key_id
      WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.client_key_id ORDER BY total DESC`).all(start, end);
    const keys = prep(`SELECT u.gemini_key_id AS id, COALESCE(k.label, '(deleted #' || u.gemini_key_id || ')') AS label,
        COUNT(*) AS total, SUM(u.ok) AS success, COUNT(*) - SUM(u.ok) AS failed
      FROM usage u LEFT JOIN api_keys k ON k.id = u.gemini_key_id
      WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.gemini_key_id ORDER BY total DESC`).all(start, end);
    const models = prep(`SELECT model, COUNT(*) AS total, SUM(ok) AS success, COUNT(*) - SUM(ok) AS failed
      FROM usage WHERE created_at >= ? AND created_at < ? GROUP BY model ORDER BY total DESC`).all(start, end);
    const matrix_client = prep(`SELECT COALESCE(k.label, '(deleted #' || u.client_key_id || ')') AS label,
        u.model AS model, COUNT(*) AS total
      FROM usage u LEFT JOIN client_keys k ON k.id = u.client_key_id
      WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.client_key_id, u.model ORDER BY total DESC`).all(start, end);
    const matrix_gemini = prep(`SELECT COALESCE(k.label, '(deleted #' || u.gemini_key_id || ')') AS label,
        u.model AS model, COUNT(*) AS total
      FROM usage u LEFT JOIN api_keys k ON k.id = u.gemini_key_id
      WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.gemini_key_id, u.model ORDER BY total DESC`).all(start, end);
    const failures_model = prep(`SELECT model, IFNULL(error_code, 'unknown') AS code, COUNT(*) AS n
      FROM usage WHERE ok = 0 AND created_at >= ? AND created_at < ? GROUP BY model, error_code ORDER BY n DESC`).all(start, end);
    return json(response, 200, { period: scope, clients, keys, models, matrix_client, matrix_gemini, failures_model });
  }

  if (url.pathname === "/api/admin/models/refresh" && request.method === "POST") {
    log("info", "Admin", `manual model refresh requested`);
    const result = await refreshModelsOnce(syntheticModelsRequest());
    const ok = result.status >= 200 && result.status < 300;
    return json(response, ok ? 200 : 502, { ok, status: result.status });
  }
  if (url.pathname === "/api/admin/client-keys" && request.method === "POST") {
    let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
    const label = String(body.label || "").trim() || nextAutoLabel("client_keys", "Client");
    const clientApiKey = createClientKey(label);
    log("info", "Admin", `client key created: '${label}' ${maskKey(clientApiKey)}`);
    return json(response, 201, { ok: true, clientApiKey });
  }
  const clientKeyMatch = url.pathname.match(/^\/api\/admin\/client-keys\/(\d+)$/);
  if (clientKeyMatch && request.method === "DELETE") { db.prepare("DELETE FROM client_keys WHERE id=?").run(Number(clientKeyMatch[1])); invalidateSecretMaskCache(); log("info", "Admin", `client key #${clientKeyMatch[1]} deleted`); return json(response, 200, { ok: true }); }
  if (url.pathname === "/api/admin/keys" && request.method === "POST") {
    let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
    const keyValue = String(body.key || "").trim();
    if (!keyValue) return json(response, 400, { error: "API key is required" });
    if (db.prepare("SELECT id FROM api_keys WHERE api_key = ?").get(keyValue)) return json(response, 409, { error: "This API key is already configured" });
    const label = String(body.label || "").trim() || nextAutoLabel("api_keys", "Key");
    db.prepare("INSERT INTO api_keys (label,api_key,created_at) VALUES (?,?,?)").run(label, keyValue, Date.now());
    invalidateSecretMaskCache();
    log("info", "Admin", `Gemini key added: '${label}' ${maskKey(keyValue)}`);
    return json(response, 201, { ok: true });
  }
  const keyMatch = url.pathname.match(/^\/api\/admin\/keys\/(\d+)$/);
  if (keyMatch && request.method === "DELETE") {
    const keyId = Number(keyMatch[1]);
    const deleted = db.prepare("SELECT label FROM api_keys WHERE id=?").get(keyId);
    prep("DELETE FROM usage WHERE gemini_key_id=?").run(keyId);
    prep("DELETE FROM model_key_state WHERE key_id=?").run(keyId);
    prep("DELETE FROM api_keys WHERE id=?").run(keyId);
    invalidateSecretMaskCache();
    log("info", "Admin", `Gemini key #${keyId}${deleted ? ` ('${deleted.label}')` : ""} deleted with its usage data`);
    return json(response, 200, { ok: true });
  }
  if (apiRoute) {
    return handleGeminiPassthrough(request, response, apiRoute.model, apiRoute.action);
  }
  dbg("HTTP", `no route matched: ${request.method} ${url.pathname}`);
  return json(response, 404, { error: "Not found" });
}

const server = http.createServer((request, response) => {
  response.on("error", () => {});
  const startedAt = Date.now();
  const peer = clientAddress(request);
  response.on("finish", () => {
    log("info", "HTTP", `${request.method} ${requestPath(request)} -> ${response.statusCode} (${Date.now() - startedAt}ms) from ${peer}`);
  });
  response.on("close", () => {
    if (!response.writableEnded) log("warn", "HTTP", `${request.method} ${requestPath(request)} ABORTED by client after ${Date.now() - startedAt}ms from ${peer}`);
  });
  handleRequest(request, response).catch((error) => {
    log("error", "HTTP", `handler failed for ${request.method} ${requestPath(request)}: ${error.stack || error.message}`);
    if (!response.headersSent) json(response, error.status || 500, { error: "Internal server error" });
    else response.destroy();
  });
});

server.on("error", (error) => {
  log("error", "Boot", `cannot start server: ${error.message}`);
  process.exit(1);
});

function shutdown(signal) {
  log("info", "Shutdown", `${signal} received; closing server`);
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("unhandledRejection", (reason) => {
  log("error", "Process", `unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

setInterval(() => {
  try {
    sweepDailyReset();
    const now = Date.now();
    let expired = 0;
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) { sessions.delete(token); expired += 1; }
    }
    if (expired) dbg("Auth", `pruned ${expired} expired session(s)`);
  } catch (error) { log("error", "Usage", `sweep failed: ${error.message}`); }
}, 60_000).unref();

server.listen(PORT, "0.0.0.0", () => {
  log("info", "Boot", `AI Studio Proxy listening on port ${PORT}${DEBUG ? " (debug logging enabled)" : " (set DEBUG=1 for debug logging)"}`);
  if (!hasAdmin()) log("info", "Setup", "no administrator yet; open the web dashboard to create one");
});

sweepDailyReset();
