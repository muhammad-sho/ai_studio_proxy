const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const zlib = require("node:zlib");
const { DatabaseSync } = require("node:sqlite");
const { loadConfig } = require("./lib/config");
const { createHttpHelpers } = require("./lib/http");
const { requestPath, parseApiRoute, parseUploadRoute, routeFamily, statsModelName, isOpenAiCompatibilityRoute, classifyRoute } = require("./lib/routing");
const { createDashboardAssets } = require("./lib/dashboard-assets");
const { createDatabase } = require("./lib/database");
const { createAuth } = require("./lib/auth");
const { createUsage } = require("./lib/usage");
const { createGeminiProxy } = require("./lib/gemini-proxy");
const { createRequestHandler } = require("./lib/admin-routes");

const {
  ADMIN_PORT, API_PORT, DB_PATH, REQUEST_TIMEOUT_MS, MAX_BODY_BYTES, MAX_RESPONSE_BYTES,
  TRANSIENT_COOLDOWN_SECONDS, LOG_BODY_MAX_BYTES, MAX_LOG_ENTRIES, MODELS_CACHE_TTL_MS,
  SESSION_TTL_MS, TRUST_PROXY, DEBUG, CORS_ORIGIN,
} = loadConfig();
const COOKIE_SESSION = "ai_studio_proxy_dashboard";
const COOKIE_CSRF = "ai_studio_proxy_csrf";

function log(level, category, message) {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${category}] ${message}`;
  if (level === "warn" || level === "error") console.error(line);
  else console.log(line);
}
const dbg = (category, message) => { if (DEBUG) log("debug", category, message); };
const maskKey = (key) => `${String(key || "").slice(0, 6)}...`;

const { db, prep } = createDatabase({ DatabaseSync, dbPath: DB_PATH, fs });

const { json, securityHeaders, readBody } = createHttpHelpers({
  corsOrigin: CORS_ORIGIN,
  maxBodyBytes: MAX_BODY_BYTES,
});
const { staticPage, sendDashboard, serveDashboardAsset } = createDashboardAssets({ fs, zlib, json });
const {
  hashValue, dashboardSessionValid, csrfValid, resolveClientKey, localKeyIsValid, clientAddress,
  rateLimited, recordLoginFailure, clearLoginFailures, hasAdmin, passwordDigest, passwordValid,
  createPasswordResetCode, passwordResetCodeActive, storePasswordResetCode, passwordResetCodeValid,
  consumePasswordResetCode, createSession, destroySession, destroyAllSessions, pruneExpiredSessions,
} = createAuth({
  prep, crypto, trustProxy: TRUST_PROXY, sessionTtlMs: SESSION_TTL_MS,
  cookieSession: COOKIE_SESSION, cookieCsrf: COOKIE_CSRF, log, isOpenAiCompatibilityRoute,
});
const {
  poolKeys, setMeta, getMeta, pacificDayStart, pacificMonthString, laDayStartUtcOfDaysAgo,
  pacificMonthRange, usageStats, invalidateSecretMaskCache, maskSecrets, clipBody,
  upstreamErrorPayload, errorCodeFromPayload, recordLog, recordUsageRow, sweepDailyReset,
  setCooldownUntil, setCooldown, nextPacificReset,
} = createUsage({ db, prep, log, maskKey, LOG_BODY_MAX_BYTES, MAX_LOG_ENTRIES });
const { handleGeminiPassthrough, handleModelsList, refreshModelsOnce, syntheticModelsRequest } = createGeminiProxy({
  https, crypto, db, prep, log, dbg, maskKey, json, readBody, requestPath, statsModelName,
  REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES, TRANSIENT_COOLDOWN_SECONDS, MODELS_CACHE_TTL_MS, LOG_BODY_MAX_BYTES,
  poolKeys, setMeta, getMeta, pacificDayStart, resolveClientKey, clientAddress,
  maskSecrets, clipBody, upstreamErrorPayload, errorCodeFromPayload, recordLog,
  recordUsageRow, setCooldown, setCooldownUntil, nextPacificReset, isOpenAiCompatibilityRoute, classifyRoute,
});
const { handleRequest } = createRequestHandler({
  crypto, db, prep, log, dbg, maskKey, json, securityHeaders, readBody, MAX_BODY_BYTES, SESSION_TTL_MS,
  parseApiRoute, parseUploadRoute,
  dashboardSessionValid, csrfValid, localKeyIsValid, clientAddress, rateLimited,
  passwordDigest, passwordValid, createPasswordResetCode, passwordResetCodeActive, storePasswordResetCode,
  passwordResetCodeValid, consumePasswordResetCode, recordLoginFailure, clearLoginFailures,
  hasAdmin, createSession, destroySession, destroyAllSessions,
  COOKIE_SESSION, COOKIE_CSRF, hashValue, invalidateSecretMaskCache,
  staticPage, sendDashboard, serveDashboardAsset,
  handleGeminiPassthrough, handleModelsList, refreshModelsOnce, syntheticModelsRequest,
  usageStats, pacificDayStart, pacificMonthRange, pacificMonthString, laDayStartUtcOfDaysAgo, getMeta,
});

function makeServer(family) {
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
    const fam = routeFamily(requestPath(request));
    if (fam !== "both" && fam !== family) {
      log("warn", "HTTP", `${request.method} ${requestPath(request)} rejected on ${family === "admin" ? "admin" : "api"} port from ${peer}`);
      return json(response, 404, { error: "Not found on this port" });
    }
    handleRequest(request, response).catch((error) => {
      log("error", "HTTP", `handler failed for ${request.method} ${requestPath(request)}: ${error.stack || error.message}`);
      if (!response.headersSent) json(response, error.status || 500, { error: "Internal server error" });
      else response.destroy();
    });
  });
  server.on("error", (error) => {
    log("error", "Boot", `cannot start server on ${family === "admin" ? `admin port ${ADMIN_PORT}` : `api port ${API_PORT}`}: ${error.message}`);
    process.exit(1);
  });
  return server;
}

const servers = [];
function startServer(server, port, label) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      log("info", "Boot", `AI Studio Proxy ${label} listening on port ${port}${DEBUG ? " (debug logging enabled)" : " (set DEBUG=1 for debug logging)"}`);
      resolve();
    });
  });
}

const setupPromise = (async () => {
  servers.push(makeServer("admin"));
  servers.push(makeServer("api"));
  await startServer(servers[0], ADMIN_PORT, "admin/dashboard");
  await startServer(servers[1], API_PORT, "API");
  if (!hasAdmin()) log("info", "Setup", "no administrator yet; open the web dashboard to create one");
})().catch((error) => {
  log("error", "Boot", `cannot start server: ${error.message}`);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "Shutdown", `${signal} received; closing server`);
  let remaining = servers.length;
  const finish = () => { try { db.close(); } catch {} process.exit(0); };
  if (!remaining) return finish();
  for (const server of servers) server.close(() => { if (--remaining === 0) finish(); });
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
    const expired = pruneExpiredSessions();
    if (expired) dbg("Auth", `pruned ${expired} expired session(s)`);
  } catch (error) { log("error", "Usage", `sweep failed: ${error.message}`); }
}, 60_000).unref();

sweepDailyReset();
