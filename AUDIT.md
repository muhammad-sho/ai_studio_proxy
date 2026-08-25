# Code Audit — AI Studio Proxy

Full line-by-line review of `server.js` (619 lines), `dashboard.html` (886 lines), and deployment files. Every High/Medium finding below was verified by code trace; the two High findings were reproduced against a mock Gemini upstream.

**Verdict:** No critical vulnerabilities. Core auth (scrypt + timingSafeEqual, CSRF double-submit bound to session, HttpOnly/SameSite=Strict cookies, parameterized SQL everywhere) is solid. The real problems are **latency under failure** and two correctness gaps in model sync.

---

## HIGH

> **Status after remediation (2026-08-24):** H1 and H2 are **fixed and verified** against the mock upstream.


### H1 — Sequential key iteration stacks timeouts (proven)
**`server.js:395-440` (`refreshModels`), `server.js:479-497` (`handleGemini`)**

Both loops try keys one at a time. A key that hangs costs `REQUEST_TIMEOUT_MS` (default 120s) before the next is tried.

- Reproduced: 3 keys × 1s delayed failure → cold `/v1beta/models` took **3.01s** (linear).
- With 30 keys and a hung upstream: worst case ≈ **60 minutes** per request.
- Cold models calls, dashboard "Refresh", and generateContent fallbacks all serialize behind this loop.

**Fix:** race keys concurrently (first 2xx wins), or bail out after N consecutive failures / a global deadline.

### H2 — DB fallback serves degraded payload and never refreshes (proven)
**`server.js:456-463`**

When `models_cache` is missing but the `models` table has names, the fallback:
1. Returns name-only objects (`{"name":"mock-pro"}` — no `displayName`, etc.).
2. Writes that thin payload back into `models_cache` with `models_checked_at = now`.
3. Never calls `refreshModelsOnce()`.

Net effect: one lost cache = up to a full TTL window (24h default) of degraded lists with no self-healing.
- Reproduced: wiped cache meta → response was `[{"name":"mock-pro"}]`; refresh counter stayed at 1.

**Fix:** serve immediately but also kick off `refreshModelsOnce(syntheticModelsRequest()).catch(...)` in the fallback path.

---

## MEDIUM

> **Status after remediation (2026-08-24):** M1–M6, M8, M9 **fixed**; M7 fixed as a side effect of H1; M3 softened (logged when tripped); M2 corrected to last-entry XFF; M4 clean 413; M5 hoisted to sweep; M10 documented as unsupported.


### M1 — Client disconnects are not propagated upstream
**`server.js:292-334`, `server.js:336-342`**
No `request.on('close')` handling in `forwardToGemini`; on completion `returnUpstream` writes to a possibly-destroyed response. Wasted upstream quota/bandwidth; async write-after-destroy errors are not caught (potential process crash vector). Fix: abort upstream on client close; guard writes with `response.destroyed`; add `response.on('error', () => {})`.

### M2 — TRUST_PROXY trusts the first XFF entry (spoofable)
**`server.js:149-155`**
Behind nginx without XFF sanitization, clients can send their own `X-Forwarded-For` and rotate identities to bypass login rate limiting. README actively recommends setting it. Fix: use the last entry (or rightmost-untrusted).

### M3 — Global login lockout can shut out the admin
**`server.js:167-173`**
1000 failures from any IPs within 15 min blocks ALL logins including the legitimate admin. Deliberate kill-switch, but it converts a distributed brute force into a cheap DoS.

### M4 — Oversized uploads are drained, not rejected
**`server.js:96-110`**
After the size limit trips, chunks are discarded but the socket keeps being read until `end` (bounded by Node's 300s requestTimeout). Fix: `request.destroy()` once over limit.

### M5 — Per-request DELETE on every successful call
**`server.js:261-265`**
`recordRequest` runs `DELETE FROM requests WHERE created_at < cutoff` on every success — redundant with the 60s sweep (`server.js:613-614`). Write amplification under load.

### M6 — Dashboard has no session-expiry recovery
**`dashboard.html:637-650` (`api()`)**
After 8h TTL, every action fails with a cryptic JSON-parse error ("Unexpected token '<'"); no redirect to login. Fix: on 401/HTML response → `location.reload()`.

### M7 — Models Refresh endpoint blocks for the whole sequential loop
**`server.js:574-578`**
Awaits `refreshModelsOnce` directly; combined with H1 the button can spin for minutes with no feedback or client timeout. Fixed as a side effect of H1; also consider returning 202 + polling.

### M8 — Session map is never swept
**`server.js:15`, `553-557`**
Expired sessions are only removed when that exact token is next seen. Unbounded growth across many logins. Fix: prune in the existing 60s interval.

### M9 — Dashboard cookie regex is unanchored
**`server.js:128`, `137`**
`/ai_studio_proxy_dashboard=([^;]+)/` matches inside longer cookie names (e.g., `xai_studio_proxy_dashboard=`); the CSRF regex right below is correctly anchored `(?:^|; )`. Inconsistent hardening.

### M10 — Only `:generateContent` is proxied
**`server.js:210-213`**
`:streamGenerateContent` (SSE) and `:countTokens` return 404, while README positions the proxy as usable by "anything". At minimum document the limitation; streaming needs a pipe-through mode.

---

## LOW / Hardening

> **Status after remediation (2026-08-24):** L3–L6, L10–L13 **fixed**. L2 (CSP nonce), L7 (per-client-key attribution), L8 (POST /models legacy route), L9 (dashboard read at boot) intentionally left as-is. L1 (setup-token compare) became moot when the setup token was removed in favor of first-visit signup.


| # | Location | Issue |
|---|---|---|
| L2 | `server.js:92` | CSP requires `'unsafe-inline'` scripts; move to nonce/hash |
| L3 | `server.js:336-342` | `returnUpstream` forwards all upstream headers except 2 (`alt-svc`, `x-request-id`, …); allowlist instead |
| L4 | `server.js:548-550` | Empty username falls back to first admin user — leaks that only password needs guessing |
| L5 | `server.js:212` | Malformed `%` in model path throws URIError → 500 instead of 400 |
| L6 | `server.js:251-258` | Usage matrix includes disabled Gemini keys |
| L7 | schema | No per-client-key usage attribution (requests.key_id = Gemini key only) |
| L8 | `server.js:510` | POST accepted on `/v1beta/models` (legacy; Google is GET-only) |
| L9 | `server.js:504` | `dashboard.html` read once at boot; changes need restart |
| L10 | `server.js:605-619` | No SIGTERM handler / graceful shutdown (`server.close`, `db.close`) |
| L11 | Dockerfile | No `HEALTHCHECK` despite `/health` endpoint |
| L12 | `README.md:123` | Says "three tabs"; there are four (How to Use added) |
| L13 | `server.js:71-72` | No index on `requests(created_at)` alone for sweep DELETEs (fine at current scale) |

---

## Verified-good (no action)

- Password hashing: scrypt(64) + random salt + `timingSafeEqual` (`server.js:186-199`)
- Setup race guarded by `BEGIN IMMEDIATE` re-check (`server.js:531-540`)
- CSRF: cookie+header+session triple match on every non-GET admin route (`server.js:142-147, 567`)
- Session cookie HttpOnly + SameSite=Strict; Secure behind HTTPS (`server.js:556-557`)
- SQL fully parameterized throughout; WAL + busy_timeout + synchronous=NORMAL
- Security headers incl. `frame-ancestors 'none'`, `nosniff`, no-store (`server.js:87-94`)
- Key masking in UI/API; plaintext `key_text` is a documented tradeoff
- Gemini-key deletion cascades to usage + cooldown rows (`server.js:594-599`)
- gzip regression fixed (accept-encoding no longer forwarded); parse-failure diagnostics logged
- Docker: root drops to uid/gid 1000 via su-exec; DB chmod 600 incl. WAL sidecars
- Sweep interval try/catch'd and unref'd (`server.js:614`)

---

## Recommended fix order

1. **H1** parallel-first-success key racing (+ fixes M7 automatically)
2. **H2** background refresh in DB fallback
3. **M1** disconnect propagation + write guards
4. **M6, M9** dashboard 401 recovery, cookie regex anchor (small, safe)
5. **M2–M5, M8** rate-limit XFF semantics, lockout policy, socket destroy, DELETE hoist, session sweep
6. Low items opportunistically (L12 doc fix trivial)
