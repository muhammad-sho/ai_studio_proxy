function createDatabase({ DatabaseSync, dbPath, fs }) {
  const db = new DatabaseSync(dbPath);
  const preparedStatements = new Map();
  function prep(sql) {
    let stmt = preparedStatements.get(sql);
    if (!stmt) preparedStatements.set(sql, (stmt = db.prepare(sql)));
    return stmt;
  }
  try { fs.chmodSync(dbPath, 0o600); } catch {}
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
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

  return { db, prep };
}

module.exports = { createDatabase };
