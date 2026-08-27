function isEnabled(value) {
  return /^(1|true|yes)$/i.test(value || "");
}

function loadConfig(env = process.env) {
  return {
    ADMIN_PORT: Number(env.ADMIN_PORT || 9009),
    API_PORT: Number(env.API_PORT || 9008),
    DB_PATH: env.DB_PATH || "./ai-studio-proxy.db",
    REQUEST_TIMEOUT_MS: Number(env.REQUEST_TIMEOUT_MS || 120000),
    MAX_BODY_BYTES: Number(env.MAX_BODY_BYTES || 50 * 1024 * 1024),
    MAX_RESPONSE_BYTES: Number(env.MAX_RESPONSE_BYTES || 50 * 1024 * 1024),
    TRANSIENT_COOLDOWN_SECONDS: 60,
    LOG_BODY_MAX_BYTES: Math.max(1024, Number(env.LOG_BODY_MAX_BYTES || 64 * 1024)),
    MAX_LOG_ENTRIES: Math.max(50, Number(env.MAX_LOG_ENTRIES || 1000)),
    REQUEST_LOG_RETENTION_MS: Math.max(1, Number(env.REQUEST_LOG_RETENTION_DAYS || 7)) * 24 * 60 * 60 * 1000,
    MODELS_CACHE_TTL_MS: Number(env.MODELS_CACHE_TTL_HOURS || 24) * 60 * 60 * 1000,
    SESSION_TTL_MS: 8 * 60 * 60 * 1000,
    TRUST_PROXY: isEnabled(env.TRUST_PROXY),
    DEBUG: isEnabled(env.DEBUG),
    CORS_ORIGIN: env.CORS_ORIGIN || "*",
  };
}

module.exports = { loadConfig };
