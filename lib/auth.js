function createAuth({ prep, crypto, trustProxy, sessionTtlMs, cookieSession, cookieCsrf, log, isOpenAiCompatibilityRoute }) {
  const sessions = new Map();
  const loginAttempts = new Map();
  const loginFailures = [];
  let globalCapLoggedAt = 0;

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
    const token = cookieValue(request, cookieSession);
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
    const cookieToken = cookieValue(request, cookieCsrf) || "";
    const headerToken = request.headers["x-csrf-token"] || "";
    return Boolean(session && cookieToken && headerToken && constantTimeEqual(cookieToken, headerToken) && constantTimeEqual(session.csrfToken, headerToken));
  }

  function resolveClientKey(request) {
    const url = new URL(request.url, "http://localhost");
    const query = url.searchParams;
    const bearer = isOpenAiCompatibilityRoute(url.pathname, request.headers)
      ? /^Bearer\s+(\S+)$/i.exec(String(request.headers.authorization || ""))?.[1] || ""
      : "";
    const supplied = request.headers["x-goog-api-key"] || query.get("key") || bearer;
    if (!supplied) return null;
    return prep("SELECT id, label FROM client_keys WHERE key_hash = ?").get(hashValue(supplied)) || null;
  }

  function localKeyIsValid(request) {
    return Boolean(resolveClientKey(request));
  }

  function clientAddress(request) {
    if (trustProxy) {
      const forwarded = request.headers["x-forwarded-for"];
      if (forwarded) return String(forwarded).split(",").pop().trim() || "unknown";
    }
    return request.socket.remoteAddress || "unknown";
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

  function clearLoginFailures(address) {
    loginAttempts.delete(address);
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

  async function createPasswordResetCode() {
    const code = crypto.randomBytes(24).toString("base64url");
    const passwordSalt = crypto.randomBytes(16).toString("hex");
    return {
      code,
      passwordSalt,
      passwordHash: await passwordDigest(code, passwordSalt),
      expiresAt: Date.now() + 15 * 60 * 1000,
    };
  }

  function passwordResetCodeRecord() {
    const rows = prep("SELECT key, value FROM app_meta WHERE key IN (?,?,?)")
      .all("password_reset_code_hash", "password_reset_code_salt", "password_reset_code_expires_at");
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const expiresAt = Number(values.password_reset_code_expires_at);
    return values.password_reset_code_hash && values.password_reset_code_salt && Number.isSafeInteger(expiresAt)
      ? { passwordHash: values.password_reset_code_hash, passwordSalt: values.password_reset_code_salt, expiresAt }
      : null;
  }

  function passwordResetCodeActive() {
    return Boolean(passwordResetCodeRecord()?.expiresAt > Date.now());
  }

  function storePasswordResetCode(resetCode) {
    const store = prep("INSERT INTO app_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    store.run("password_reset_code_hash", resetCode.passwordHash);
    store.run("password_reset_code_salt", resetCode.passwordSalt);
    store.run("password_reset_code_expires_at", String(resetCode.expiresAt));
  }

  async function passwordResetCodeValid(code) {
    const resetCode = passwordResetCodeRecord();
    if (!resetCode || resetCode.expiresAt <= Date.now()) return null;
    return await passwordValid(String(code || ""), { password_hash: resetCode.passwordHash, password_salt: resetCode.passwordSalt })
      ? resetCode : null;
  }

  function consumePasswordResetCode(resetCode) {
    const consumed = prep("DELETE FROM app_meta WHERE key=? AND value=?").run("password_reset_code_hash", resetCode.passwordHash).changes === 1;
    if (consumed) prep("DELETE FROM app_meta WHERE key IN (?,?)").run("password_reset_code_salt", "password_reset_code_expires_at");
    return consumed;
  }

  function createSession() {
    const token = crypto.randomBytes(32).toString("hex");
    const csrfToken = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { expiresAt: Date.now() + sessionTtlMs, csrfToken });
    return { token, csrfToken };
  }

  function destroySession(request) {
    const token = cookieValue(request, cookieSession);
    if (token) sessions.delete(token);
  }

  function destroyAllSessions() {
    sessions.clear();
  }

  function pruneExpiredSessions() {
    const now = Date.now();
    let expired = 0;
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) { sessions.delete(token); expired += 1; }
    }
    return expired;
  }

  return {
    hashValue, cookieValue, dashboardSessionValid, csrfValid, resolveClientKey, localKeyIsValid,
    clientAddress, rateLimited, recordLoginFailure, clearLoginFailures, hasAdmin,
    passwordDigest, passwordValid, createPasswordResetCode, passwordResetCodeActive, storePasswordResetCode,
    passwordResetCodeValid, consumePasswordResetCode, createSession, destroySession, destroyAllSessions, pruneExpiredSessions,
  };
}

module.exports = { createAuth };
