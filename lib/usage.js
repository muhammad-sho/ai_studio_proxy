function routingBalanceScore(usageRows, keys) {
  const keyIds = [...new Set((keys || [])
    .map((key) => Number(key?.id))
    .filter((id) => Number.isSafeInteger(id)))];
  if (!keyIds.length) return null;
  if (keyIds.length === 1) return 100;

  function gini(values) {
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!total) return 0;
    let difference = 0;
    for (const left of values) {
      for (const right of values) difference += Math.abs(left - right);
    }
    return difference / (2 * values.length * total);
  }

  const byModel = new Map();
  for (const row of usageRows || []) {
    const model = String(row?.model || "").trim();
    const keyId = Number(row?.key_id);
    const today = Math.max(0, Number(row?.today) || 0);
    if (!model || !keyIds.includes(keyId) || !today) continue;
    const counts = byModel.get(model) || new Map();
    counts.set(keyId, (counts.get(keyId) || 0) + today);
    byModel.set(model, counts);
  }

  // Compare each model to the most even whole-request distribution possible.
  // A single request cannot be split, so it is a perfect rotation result rather
  // than a 0% balance result.
  const keyCount = keyIds.length;
  const worstGini = (keyCount - 1) / keyCount;
  let weightedScore = 0;
  let totalRequests = 0;
  for (const counts of byModel.values()) {
    const values = keyIds.map((keyId) => counts.get(keyId) || 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    if (!total) continue;

    const base = Math.floor(total / keyCount);
    const extra = total % keyCount;
    const bestPossible = Array.from({ length: keyCount }, (_, index) => base + (index < extra ? 1 : 0));
    const observedGini = gini(values);
    const bestGini = gini(bestPossible);
    const range = worstGini - bestGini;
    const score = range <= Number.EPSILON
      ? 100
      : Math.max(0, Math.min(100, 100 * (1 - (observedGini - bestGini) / range)));

    weightedScore += score * total;
    totalRequests += total;
  }
  return totalRequests ? Math.round(weightedScore / totalRequests) : null;
}

function createUsage({ prep, log, maskKey, LOG_BODY_MAX_BYTES, MAX_LOG_ENTRIES }) {
  const laOffsetFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", timeZoneName: "longOffset",
  });
  const laDateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const laMonthFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
  });

  function poolKeys() {
    return prep("SELECT id, api_key FROM api_keys ORDER BY id").all();
  }

  function laOffsetMinutes(at) {
    const offsetPart = laOffsetFormatter.formatToParts(new Date(at)).find((part) => part.type === "timeZoneName")?.value || "GMT+00:00";
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
    const dateParts = laDateFormatter.formatToParts(new Date(now));
    const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
    return laDayStartUtc(Number(values.year), Number(values.month) - 1, Number(values.day));
  }

  function pacificMonthString(now = Date.now()) {
    const parts = laMonthFormatter.formatToParts(new Date(now));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}`;
  }

  function laDayStartUtcOfDaysAgo(days) {
    return laDayStartUtc(...(function () {
      const parts = laDateFormatter.formatToParts(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
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
    const now = Date.now();
    return prep(`
      WITH active_pairs AS (
        SELECT model, gemini_key_id AS key_id, COUNT(*) AS today, MAX(created_at) AS last_request
        FROM usage
        WHERE ok = 1 AND created_at >= ? AND gemini_key_id IS NOT NULL
        GROUP BY model, gemini_key_id
        UNION ALL
        SELECT model, key_id, 0 AS today, NULL AS last_request
        FROM model_key_state
        WHERE cooldown_until > ?
      )
      SELECT pairs.model, k.id AS key_id, k.label,
             substr(k.api_key, 1, 6) || '...' AS masked,
             SUM(pairs.today) AS today, MAX(pairs.last_request) AS last_request,
             COALESCE(s.cooldown_until, 0) AS cooldown_until,
             COALESCE(s.cooldown_reason, '') AS cooldown_reason
      FROM active_pairs pairs
      JOIN api_keys k ON k.id = pairs.key_id
      LEFT JOIN model_key_state s ON s.model = pairs.model AND s.key_id = pairs.key_id
      GROUP BY pairs.model, k.id, k.label, k.api_key, s.cooldown_until, s.cooldown_reason
      ORDER BY pairs.model, k.id
    `).all(start, now);
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
    if (Buffer.byteLength(text, "utf8") <= LOG_BODY_MAX_BYTES) return text;
    return Buffer.from(text, "utf8").subarray(0, LOG_BODY_MAX_BYTES).toString("utf8") + "...[truncated]";
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
    if (purgedCooldowns || purgedLogs || purgedAgedLogs) {
      dbg("Usage", `sweep removed ${purgedCooldowns} expired cooldown(s), ${purgedLogs} excess log entr(ies), ${purgedAgedLogs} aged log entr(ies)`);
    }
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


  return {
    poolKeys, pacificDayStart, pacificMonthString, laDayStartUtcOfDaysAgo,
    pacificMonthRange, usageStats, invalidateSecretMaskCache, maskSecrets, clipBody,
    upstreamErrorPayload, errorCodeFromPayload, recordLog, recordUsageRow, sweepDailyReset,
    setCooldownUntil, setCooldown, nextPacificReset,
  };
}

module.exports = { createUsage, routingBalanceScore };
