function isEnabled(value) {
  return /^(1|true|yes)$/i.test(value || "");
}

function positiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function minimumInteger(value, fallback, minimum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.max(minimum, parsed) : fallback;
}

function loadConfig(env = process.env) {
  return {
    ADMIN_PORT: positiveInteger(env.ADMIN_PORT, 9009, 1, 65_535),
    API_PORT: positiveInteger(env.API_PORT, 9008, 1, 65_535),
    DB_PATH: env.DB_PATH || "./ai-studio-proxy.db",
    REQUEST_TIMEOUT_MS: positiveInteger(env.REQUEST_TIMEOUT_MS, 120_000, 1, 2_147_483_647),
    MAX_BODY_BYTES: positiveInteger(env.MAX_BODY_BYTES, 50 * 1024 * 1024),
    MAX_RESPONSE_BYTES: positiveInteger(env.MAX_RESPONSE_BYTES, 50 * 1024 * 1024),
    TRANSIENT_COOLDOWN_SECONDS: 60,
    LOG_BODY_MAX_BYTES: minimumInteger(env.LOG_BODY_MAX_BYTES, 64 * 1024, 1_024),
    MAX_LOG_ENTRIES: minimumInteger(env.MAX_LOG_ENTRIES, 1_000, 50),
    USAGE_RETENTION_DAYS: positiveInteger(env.USAGE_RETENTION_DAYS, 0, 0, 36_500),
    MODELS_CACHE_TTL_MS: positiveInteger(env.MODELS_CACHE_TTL_HOURS, 24) * 60 * 60 * 1000,
    SESSION_TTL_MS: 8 * 60 * 60 * 1000,
    TRUST_PROXY: isEnabled(env.TRUST_PROXY),
    DEBUG: isEnabled(env.DEBUG),
    CORS_ORIGIN: env.CORS_ORIGIN || "*",
  };
}

module.exports = { loadConfig };
