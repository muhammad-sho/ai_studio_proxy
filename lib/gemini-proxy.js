function createGeminiProxy({
  https, crypto, db, prep, log, dbg, maskKey, json, readBody, requestPath, statsModelName,
  REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES, TRANSIENT_COOLDOWN_SECONDS, MODELS_CACHE_TTL_MS, LOG_BODY_MAX_BYTES,
  poolKeys, setMeta, getMeta, pacificDayStart, resolveClientKey, clientAddress,
  maskSecrets, clipBody, upstreamErrorPayload, errorCodeFromPayload, recordLog,
  recordUsageRow, setCooldown, setCooldownUntil, nextPacificReset, isOpenAiCompatibilityRoute, classifyRoute,
}) {
  const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer"]);
  const classify = classifyRoute || ((pathname, method, urlModel, action) => ({ kind: "inference", model: urlModel, trackUsage: true, balanceByModel: true, statsModel: urlModel ? (action ? statsModelName(urlModel, action, pathname) : urlModel) : pathname }));

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
        "authorization", "cookie", "content-length", "x-goog-api-key"]);
      const headers = {};
      for (const [name, value] of Object.entries(context.headers || {})) {
        const lower = name.toLowerCase();
        if (!droppedHeaders.has(lower) && !lower.startsWith("proxy-")) headers[name] = value;
      }
      headers["content-length"] = body.length;
      if (isOpenAiCompatibilityRoute(upstreamUrl.pathname)) headers.authorization = `Bearer ${key}`;
      else headers["x-goog-api-key"] = key;
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
        const success = response.statusCode >= 200 && response.statusCode < 300;
        const contentLength = Number(response.headers["content-length"]);
        const isEventStream = String(response.headers["content-type"] || "").includes("event-stream");
        // Preserve the configured response ceiling: non-SSE responses without a
        // trustworthy size keep the bounded-buffer path below.
        if (opts.stream && success && (isEventStream || (Number.isFinite(contentLength) && contentLength <= MAX_RESPONSE_BYTES))) {
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
    const pathname = requestPath(request);
    let modelName = statsModelName(model, action, pathname);
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
    const routePolicy = classify(pathname, request.method, model, action, body);
    modelName = routePolicy.statsModel || (routePolicy.kind === "metadata" ? `[metadata] ${pathname}` : pathname);
    const trackUsage = routePolicy.trackUsage;
    mark("route", `${routePolicy.kind} route${routePolicy.model ? ` for ${routePolicy.model}` : ""}; usage tracking ${trackUsage ? "enabled" : "disabled"}`);

    const everyKey = prep("SELECT * FROM api_keys ORDER BY id").all();
    if (!everyKey.length) {
      log("warn", "Gemini", `[${short}] ${modelName}: request rejected, no Gemini API keys configured`);
      mark("reject", "no Gemini API keys configured");
      recordLog({ model: modelName, traceId, events, status: 503, outcome: "rejected", errorCode: "NO_KEYS_CONFIGURED" });
      return json(response, 503, { error: { code: 503, status: "UNAVAILABLE", message: "No Gemini API keys are configured" } });
    }
    const usage = trackUsage ? prep("SELECT gemini_key_id AS key_id, COUNT(*) AS count FROM usage WHERE model = ? AND ok = 1 AND created_at >= ? GROUP BY gemini_key_id")
      .all(modelName, pacificDayStart()).reduce((map, row) => map.set(row.key_id, row.count), new Map()) : new Map();
    const coolingRows = trackUsage ? new Map(prep("SELECT key_id, cooldown_until, cooldown_reason FROM model_key_state WHERE model = ?")
      .all(modelName).filter((row) => row.cooldown_until > Date.now()).map((row) => [row.key_id, row])) : new Map();
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
      // Successful responses can be relayed immediately. Error responses remain buffered
      // below so quota classification and cooldown behavior stay unchanged.
      const relaySuccessfulResponse = true;
      const result = await forwardToGemini(upstreamContext, body, selected.api_key, { clientResponse: response, traceId, stream: relaySuccessfulResponse });
      if (result.stream) {
        const outHeaders = filterResponseHeaders(result.headers);
        if (outHeaders["x-goog-upload-url"]) {
          outHeaders["x-goog-upload-url"] = rewriteUploadUrl(outHeaders["x-goog-upload-url"], request);
        }
        response.writeHead(result.status, outHeaders);
        mark("relay", `streaming Google's successful response to the client (status ${result.status})`);
        if (trackUsage) recordUsageRow(modelName, clientKey.id, selected.id, "success", true, result.status, null);
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
      if (trackUsage && classification === "daily_quota") {
        cooldownUntil = nextPacificReset();
        cooldownReason = "daily_quota";
        log("warn", "Gemini", `[${short}] key #${selected.id} hit daily quota on ${modelName}; cooldown until Pacific midnight`);
        mark("cooldown", `key #${selected.id} benched until Pacific midnight (daily_quota)`);
      } else if (trackUsage && (classification === "transient" || classification === "invalid_key")) {
        const reason = classification === "invalid_key" ? "invalid_key" : (hasQuotaDetails(errorPayload) ? "high_demand" : "capacity");
        cooldownUntil = Date.now() + TRANSIENT_COOLDOWN_SECONDS * 1000;
        cooldownReason = reason;
        log("warn", "Gemini", `[${short}] key #${selected.id} got ${result.status} (${classification}/${reason}) on ${modelName}; cooldown ${TRANSIENT_COOLDOWN_SECONDS}s`);
        mark("cooldown", `key #${selected.id} benched ${TRANSIENT_COOLDOWN_SECONDS}s (${reason})`);
      }
      mark("relay", `relaying Google's response as-is to the client (status ${result.status})`);
      try {
        db.exec("BEGIN");
        if (trackUsage) prep("INSERT INTO usage (created_at,model,client_key_id,gemini_key_id,outcome,ok,status,error_code) VALUES (?,?,?,?,?,?,?,?)")
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
      if (trackUsage) setCooldown(modelName, selected.id, TRANSIENT_COOLDOWN_SECONDS, "upstream_error");
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
    if (trackUsage) recordUsageRow(modelName, clientKey?.id, selected?.id, "failed", false, 502, "NO_UPSTREAM_RESPONSE");
    recordLog({ model: modelName, traceId, events, status: 502, outcome: "failed", errorCode: "NO_UPSTREAM_RESPONSE", attempt: 1, requestBody: body });
    return json(response, 502, { error: { code: 502, status: "BAD_GATEWAY", message: "Gemini did not respond on any attempted key" } });
  }


  return { handleGeminiPassthrough, handleModelsList, refreshModelsOnce, syntheticModelsRequest, forwardToGemini };
}

module.exports = { createGeminiProxy };
