# AGENTS.md

## Stack

- Zero-dependency Node.js (22+): `server.js` (~1000 lines) is the entire backend — HTTP server, SQLite via built-in `node:sqlite`, upstream forwarding, and the dashboard/setup/sign-in UI.
- `dashboard.html` is the entire main UI (CSS + JS + markup in one file); `setup.html` and `signin.html` are the two minimal auth pages, lazily read from disk only when first requested (`staticPage()`). No build step.
- No `package.json`, no test framework, no linter. Don't add dependencies or tooling without being asked.

## Verification (no test suite exists)

```bash
node --check server.js          # JS syntax
sh -n entrypoint.sh             # shell syntax
python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['docker-compose.yml','docker-compose.dev.yml','.github/workflows/publish-ghcr.yml']]"
```

Functional testing = boot on a scratch port with a temp DB and drive the API:

```bash
PORT=18970 DB_PATH=/tmp/x/db timeout 10 node server.js &
# must run from the project directory (see gotchas)
curl -X POST localhost:18970/api/setup -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123"}'
```

Admin POST/DELETE need CSRF: log in with `curl -c jar`, then extract the token from the cookie jar (`awk '$6=="ai_studio_proxy_csrf" {print $7}' "$J"`) and send `-H "x-csrf-token: $CSRF"`. GETs need only the session cookie.

## Gotchas

- **cwd matters**: `server.js` reads `dashboard.html` relative to the working directory. Running `node server.js` from anywhere else crashes at boot. Docker sets WORKDIR /app, so only affects local runs.
- To simulate upstream failures, append `127.0.0.1 generativelanguage.googleapis.com` to `/etc/hosts`, and remove it afterwards (verify with `rg googleapis /etc/hosts`). Node's keep-alive agent reuses sockets, so DNS tricks don't affect requests already warmed in the same process — restart the server after changing hosts. Permanent-looking 400s from "Google" during such tests mean the blackhole didn't apply.
- Invalid Gemini API keys get a real Google `400 INVALID_ARGUMENT` (classified permanent, returned as-is). 429/5xx/transport errors trigger cooldowns; there is no retry — every request is attempted once.
- `.gitignore` covers `*.db*` — never commit databases; use `/tmp` for test DBs.

## Behavior contracts

- Every request is attempted exactly once on the best available key (least-used ready, else soonest-expiring cooldown); the upstream response is always relayed as-is. Do not reintroduce retry/fallback logic without asking.
- The proxy is a strict pass-through: all methods and any path under v1/v1beta/v1alpha are forwarded (including SSE streaming), with only hop-by-hop/credential headers stripped and the API key swapped. Don't add request/response rewriting or re-introduce endpoint allowlists without asking.
- Cooldowns have exactly two cases: transient failures bench a key 60 s (`TRANSIENT_COOLDOWN_SECONDS`), daily-quota benches until Pacific midnight. Don't reintroduce other cooldown sources without asking.
- `usage` table is the single source of truth for every request (client key, Gemini key, model, outcome, status, error code); it is kept forever and read by routing only through ok=1/since-reset filters.
- `request_logs` holds detailed debugging payloads; app logic never reads it — only the dashboard Logs view does. Retention (hourly sweep): expired cooldowns deleted immediately, request logs capped at 1,000 entries AND 7 days, `usage` rows never pruned.
- Hot-path SQL goes through `prep(sql)`, which caches compiled statements — only for **fixed** SQL strings. Never pass dynamically interpolated SQL (filters, IN-lists) to `prep()`; that leaks memory. Terminal bookkeeping per request (usage insert, cooldown upsert, request log, model stat) runs in a single transaction.
- Schema changes are additive `CREATE TABLE IF NOT EXISTS` only — legacy ALTER-migrations were deliberately removed; don't add migration shims.
- `maskSecrets()` caches key→mask pairs; invalidate via `invalidateSecretMaskCache()` wherever keys are inserted/deleted.
- Cookie names (`ai_studio_proxy_dashboard`/`_csrf`) and localStorage keys (`ai_studio_proxy_*`) are load-bearing identifiers renamed during the project rebrand — renaming them logs users out.

## Stability policy (real users are live)

The app is past initial testing and running for real users. Every change must be non-destructive: never break the app's availability and never lose or corrupt existing data.

- Data migrations must be automatic, guarded, and idempotent (see `entrypoint.sh`: rename-only-if-target-missing). Never delete or overwrite user data; move it.
- Schema changes are additive only (see Behavior contracts); new code must keep working against databases created by older versions.
- Preserve env var names, defaults, cookie/localStorage names, API routes and response shapes — deprecate instead of removing; breaking renames need explicit owner approval.
- Before pushing anything that touches storage or startup, test the upgrade path with a database/files laid out like an existing deployment (old filenames, populated tables), not just a fresh install.
- If a change can't be made non-destructively, stop and ask the owner first.

## Naming & docs conventions

- Known accepted trade-offs (former audit findings, deliberately not fixed): CSP allows `'unsafe-inline'` scripts (dashboard is one static file); usage attribution is per Gemini key only, not per client key; `POST /v1beta/models` is accepted alongside GET (legacy compatibility); `dashboard.html` is read once at boot, so UI edits need a restart. Don't "fix" these silently — they're owner-approved.
- Repo is `ai_studio_proxy` (underscores); Docker image/service/container are `ai-studio-proxy` (hyphens); internal identifiers use underscores. Default port is 9009.
- README and all UI copy must state facts that match current behavior — the owner audits both for accuracy. Use neutral product language ("optional", purpose-first descriptions); no conversational phrasing that references feature requests or implementation history.
- Deploy = push to `origin/main` (GHCR workflow publishes `latest`; semver tags on `v*.*.*`). The owner's standing workflow: review, test, then push after finishing.
