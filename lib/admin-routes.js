function createRequestHandler({
  crypto, db, prep, log, dbg, json, securityHeaders, readBody,
  MAX_BODY_BYTES, SESSION_TTL_MS,
  parseApiRoute, parseUploadRoute,
  dashboardSessionValid, csrfValid, localKeyIsValid, clientAddress, rateLimited,
  passwordDigest, passwordValid, recordLoginFailure, clearLoginFailures, hasAdmin, createSession, destroySession,
  COOKIE_SESSION, COOKIE_CSRF, hashValue, invalidateSecretMaskCache,
  staticPage, sendDashboard, serveDashboardAsset,
  handleGeminiPassthrough, handleModelsList, refreshModelsOnce, syntheticModelsRequest,
  usageStats, pacificDayStart, pacificMonthRange, pacificMonthString, laDayStartUtcOfDaysAgo, getMeta,
}) {
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

  function createClientKey(label) {
    const value = crypto.randomBytes(32).toString("base64url");
    db.prepare("INSERT INTO client_keys (label,key_hash,key_prefix,key_text,created_at) VALUES (?,?,?,?,?)")
      .run(label, hashValue(value), `${value.slice(0, 8)}...`, value, Date.now());
    invalidateSecretMaskCache();
    return value;
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
      if (!hasAdmin()) { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return response.end(staticPage("setup.html")); }
      if (!dashboardSessionValid(request)) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return response.end(staticPage("signin.html"));
      }
      return sendDashboard(request, response);
    }
    if (url.pathname === "/dashboard.css" || url.pathname === "/dashboard.js" || url.pathname.startsWith("/panels/")) {
      if (!dashboardSessionValid(request)) return json(response, 401, { error: "Dashboard login required" });
      return serveDashboardAsset(request, response, url.pathname);
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
      clearLoginFailures(address);
      const { token, csrfToken } = createSession();
      log("info", "Auth", `user '${username}' logged in from ${address} (session expires in ${SESSION_TTL_MS / 3600000}h)`);
      const secure = request.headers["x-forwarded-proto"] === "https" || request.socket.encrypted ? "; Secure" : "";
      response.writeHead(302, { Location: "/", "Cache-Control": "no-store", "Set-Cookie": [`${COOKIE_SESSION}=${token}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`, `${COOKIE_CSRF}=${csrfToken}; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`] }); return response.end();
    }
    if (url.pathname === "/logout" && request.method === "POST") {
      if (!csrfValid(request)) return json(response, 403, { error: "Invalid CSRF token" });
      destroySession(request);
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
      const view = new Set(["all", "clients", "gemini", "statistics"]).has(url.searchParams.get("view"))
        ? url.searchParams.get("view") : "all";
      const payload = { period: scope };
      if (view === "all" || view === "clients") {
        payload.clients = prep(`SELECT u.client_key_id AS id, COALESCE(k.label, '(deleted #' || u.client_key_id || ')') AS label,
            COUNT(*) AS total, SUM(u.ok) AS success, COUNT(*) - SUM(u.ok) AS failed
          FROM usage u LEFT JOIN client_keys k ON k.id = u.client_key_id
          WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.client_key_id ORDER BY total DESC`).all(start, end);
        payload.matrix_client = prep(`SELECT COALESCE(k.label, '(deleted #' || u.client_key_id || ')') AS label,
            u.model AS model, COUNT(*) AS total
          FROM usage u LEFT JOIN client_keys k ON k.id = u.client_key_id
          WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.client_key_id, u.model ORDER BY total DESC`).all(start, end);
      }
      if (view === "all" || view === "gemini") {
        payload.keys = prep(`SELECT u.gemini_key_id AS id, COALESCE(k.label, '(deleted #' || u.gemini_key_id || ')') AS label,
            COUNT(*) AS total, SUM(u.ok) AS success, COUNT(*) - SUM(u.ok) AS failed
          FROM usage u LEFT JOIN api_keys k ON k.id = u.gemini_key_id
          WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.gemini_key_id ORDER BY total DESC`).all(start, end);
        payload.matrix_gemini = prep(`SELECT COALESCE(k.label, '(deleted #' || u.gemini_key_id || ')') AS label,
            u.model AS model, COUNT(*) AS total
          FROM usage u LEFT JOIN api_keys k ON k.id = u.gemini_key_id
          WHERE u.created_at >= ? AND u.created_at < ? GROUP BY u.gemini_key_id, u.model ORDER BY total DESC`).all(start, end);
      }
      if (view === "all" || view === "statistics") {
        payload.models = prep(`SELECT model, COUNT(*) AS total, SUM(ok) AS success, COUNT(*) - SUM(ok) AS failed
          FROM usage WHERE created_at >= ? AND created_at < ? GROUP BY model ORDER BY total DESC`).all(start, end);
        payload.failures_model = prep(`SELECT model, IFNULL(error_code, 'unknown') AS code, COUNT(*) AS n
          FROM usage WHERE ok = 0 AND created_at >= ? AND created_at < ? GROUP BY model, error_code ORDER BY n DESC`).all(start, end);
      }
      return json(response, 200, payload);
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
    if (clientKeyMatch && request.method === "PATCH") {
      const keyId = Number(clientKeyMatch[1]);
      let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
      const existing = db.prepare("SELECT * FROM client_keys WHERE id=?").get(keyId);
      if (!existing) return json(response, 404, { error: "Client key not found" });
      let newKey = null;
      const regenKey = body.key !== undefined && String(body.key).trim() !== "";
      if (regenKey) {
        newKey = crypto.randomBytes(32).toString("base64url");
        db.prepare("UPDATE client_keys SET key_hash=?, key_prefix=?, key_text=? WHERE id=?")
          .run(hashValue(newKey), `${newKey.slice(0, 8)}...`, newKey, keyId);
      }
      if (body.label !== undefined) {
        const label = String(body.label).trim();
        if (!label) return json(response, 400, { error: "Label cannot be empty" });
        db.prepare("UPDATE client_keys SET label=? WHERE id=?").run(label, keyId);
      }
      invalidateSecretMaskCache();
      log("info", "Admin", `client key #${keyId}${regenKey ? " regenerated" : " updated"}${body.label !== undefined ? ` (label '${String(body.label).trim()}')` : ""}`);
      return json(response, 200, { ok: true, clientApiKey: newKey });
    }
    if (clientKeyMatch && request.method === "GET") {
      const row = db.prepare("SELECT label, key_text FROM client_keys WHERE id=?").get(Number(clientKeyMatch[1]));
      if (!row) return json(response, 404, { error: "Client key not found" });
      return json(response, 200, { ok: true, label: row.label, key: row.key_text || null });
    }
    if (clientKeyMatch && request.method === "DELETE") { db.prepare("DELETE FROM client_keys WHERE id=?").run(Number(clientKeyMatch[1])); invalidateSecretMaskCache(); log("info", "Admin", `client key #${clientKeyMatch[1]} deleted`); return json(response, 200, { ok: true }); }
    if (url.pathname === "/api/admin/keys" && request.method === "POST") {
      let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
      const bulkKeys = Array.isArray(body.keys) ? body.keys : null;
      if (bulkKeys) {
        const results = [];
        const insert = db.prepare("INSERT INTO api_keys (label,api_key,created_at) VALUES (?,?,?)");
        const dupeCheck = db.prepare("SELECT id FROM api_keys WHERE api_key = ?");
        for (let i = 0; i < bulkKeys.length; i++) {
          const keyValue = String(bulkKeys[i] || "").trim();
          if (!keyValue) { results.push({ key: "(empty)", status: "skipped", error: "empty" }); continue; }
          if (dupeCheck.get(keyValue)) { results.push({ key: maskKey(keyValue), status: "skipped", error: "duplicate" }); continue; }
          const label = nextAutoLabel("api_keys", "Key");
          insert.run(label, keyValue, Date.now());
          results.push({ key: maskKey(keyValue), label, status: "added" });
          log("info", "Admin", `Gemini key added: '${label}' ${maskKey(keyValue)}`);
        }
        invalidateSecretMaskCache();
        const added = results.filter((r) => r.status === "added").length;
        const skipped = results.filter((r) => r.status === "skipped").length;
        return json(response, 201, { ok: true, added, skipped, results });
      }
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
    if (keyMatch && request.method === "PATCH") {
      const keyId = Number(keyMatch[1]);
      let body; try { body = JSON.parse((await readBody(request)).toString()); } catch { return json(response, 400, { error: "Invalid JSON" }); }
      const existing = db.prepare("SELECT * FROM api_keys WHERE id=?").get(keyId);
      if (!existing) return json(response, 404, { error: "Gemini key not found" });
      const newValue = String(body.key || "").trim();
      if (newValue) {
        if (db.prepare("SELECT id FROM api_keys WHERE api_key = ? AND id != ?").get(newValue, keyId)) return json(response, 409, { error: "This API key is already configured" });
        db.prepare("UPDATE api_keys SET api_key=? WHERE id=?").run(newValue, keyId);
      }
      if (body.label !== undefined) {
        const label = String(body.label).trim();
        if (!label) return json(response, 400, { error: "Label cannot be empty" });
        db.prepare("UPDATE api_keys SET label=? WHERE id=?").run(label, keyId);
      }
      invalidateSecretMaskCache();
      log("info", "Admin", `Gemini key #${keyId} updated${newValue ? ` (new key ${maskKey(newValue)})` : ""}${body.label !== undefined ? ` (label '${String(body.label).trim()}')` : ""}`);
      return json(response, 200, { ok: true });
    }
    if (keyMatch && request.method === "DELETE") {
      const keyId = Number(keyMatch[1]);
      const deleted = db.prepare("SELECT label FROM api_keys WHERE id=?").get(keyId);
      prep("DELETE FROM model_key_state WHERE key_id=?").run(keyId);
      prep("DELETE FROM api_keys WHERE id=?").run(keyId);
      invalidateSecretMaskCache();
      log("info", "Admin", `Gemini key #${keyId}${deleted ? ` ('${deleted.label}')` : ""} deleted; historical usage retained`);
      return json(response, 200, { ok: true });
    }
    if (apiRoute) {
      return handleGeminiPassthrough(request, response, apiRoute.model, apiRoute.action);
    }
    dbg("HTTP", `no route matched: ${request.method} ${url.pathname}`);
    return json(response, 404, { error: "Not found" });
  }


  return { handleRequest };
}

module.exports = { createRequestHandler };
