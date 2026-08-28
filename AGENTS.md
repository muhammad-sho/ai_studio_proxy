# AGENTS.md

## Code navigation

- Read [docs/CODEMAP.md](docs/CODEMAP.md) before editing server behavior. It maps each responsibility, public contract, test location, and debugging starting point.
- Keep every server line within its documented owner. Cross-owner changes need a test for the shared behavior.

## Stack

- Zero-dependency Node.js (22+): `server.js` is the bootstrap only. Backend ownership is split under `lib/` for configuration, SQLite, HTTP, authentication, routing, dashboard assets, usage, Gemini forwarding, and request handlers; see `docs/CODEMAP.md`.
- The main UI lives in `dashboard/` (no build step): `index.html` is the shell (header, nav, modals); `dashboard.css` is shared CSS; `dashboard.js` owns navigation and shared UI; each tab has a `panels/<name>.html` partial and may have a sibling lazy controller. Only the active tab is fetched initially; visited tabs are kept in browser memory. Assets are authenticated, cached in-process, and privately revalidated with ETags. `setup.html` and `signin.html` are the two minimal auth pages, also lazy-read.
- No `package.json`, external test framework, linter, or runtime dependencies. The built-in `node:test` suite in `test/` is required for behavior changes. Runtime limits have safe defaults; malformed internal configuration must not disable a limit.

## Verification

```bash
node --check server.js
find lib -type f -name '*.js' -print0 | xargs -0 -r -n 1 node --check
find dashboard -type f -name '*.js' -print0 | xargs -0 -r -n 1 node --check
node --test
sh -n entrypoint.sh
docker compose -f docker-compose.yml config --quiet
python3 -c "import yaml; [yaml.safe_load(open(f)) for f in ['docker-compose.yml','docker-compose.dev.yml','.github/workflows/publish-ghcr.yml']]"
```

Functional testing = boot on a scratch port with a temp DB and drive the API:

```bash
ADMIN_PORT=18970 API_PORT=18971 DB_PATH=/tmp/x/db timeout 10 node server.js &
# must run from the project directory (see gotchas)
curl -X POST localhost:18970/api/setup -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123","passwordConfirmation":"testpass123"}'
```

Admin POST/DELETE need CSRF: log in with `curl -c jar`, then extract the token from the cookie jar (`awk '$6=="ai_studio_proxy_csrf" {print $7}' "$J"`) and send `-H "x-csrf-token: $CSRF"`. GETs need only the session cookie.

## Gotchas

- **cwd matters**: `server.js` reads `dashboard/`, `setup.html`, and `signin.html` relative to the working directory. Running `node server.js` from anywhere else crashes at boot. Docker sets WORKDIR /app, so only affects local runs.
- To simulate upstream failures, append `127.0.0.1 generativelanguage.googleapis.com` to `/etc/hosts`, and remove it afterwards (verify with `rg googleapis /etc/hosts`). Node's keep-alive agent reuses sockets, so DNS tricks don't affect requests already warmed in the same process — restart the server after changing hosts. Permanent-looking 400s from "Google" during such tests mean the blackhole didn't apply.
- Invalid Gemini API keys get a real Google `400 INVALID_ARGUMENT` (classified permanent, returned as-is). 429/5xx/transport errors trigger cooldowns; there is no retry — every request is attempted once.
- `.gitignore` covers `*.db*` — never commit databases; use `/tmp` for test DBs.

## Behavior contracts

- Every request is attempted exactly once on the best available key (least-used ready, else soonest-expiring cooldown); the upstream response is always relayed as-is. Do not reintroduce retry/fallback logic without asking.
- The proxy is a strict HTTP pass-through: all methods and any path under v1/v1beta/v1alpha are forwarded (including SSE streaming), with only hop-by-hop/credential headers stripped and the selected key swapped. Native Gemini routes use `x-goog-api-key`; `/v*/openai/` routes use Bearer authentication. Gemini Live WebSockets are intentionally unsupported. Don't add request/response rewriting or endpoint allowlists without asking.
- Cooldowns have exactly two cases: transient failures bench a key 60 s (`TRANSIENT_COOLDOWN_SECONDS`), daily-quota benches until Pacific midnight. Don't reintroduce other cooldown sources without asking.
- `usage` table is the single source of truth for every request (client key, Gemini key, model, outcome, status, error code); it is kept forever, including after either key is deleted, and is read by routing only through `ok=1`/since-reset filters.
- `GET /api/admin/usage` returns its complete historical response shape by default. The dashboard may pass `view=clients`, `view=gemini`, or `view=statistics` to request only the active tab's aggregates; preserve the default response when changing this route.
- `request_logs` holds detailed debugging payloads; app logic never reads it — only the dashboard Logs view does. Retention (minute sweep): expired cooldowns are deleted immediately; request logs are capped at 1,000 entries and seven days. Usage rows are retained forever.
- Hot-path SQL goes through `prep(sql)`, which caches compiled statements — only for **fixed** SQL strings. Never pass dynamically interpolated SQL (filters, IN-lists) to `prep()`; that leaks memory. Buffered error responses write usage, cooldown state, and request logs atomically; successful responses record usage before their stream completes and record the capped diagnostic log at stream completion.
- Schema setup is declarative: keep `CREATE TABLE IF NOT EXISTS` definitions and avoid ad-hoc `ALTER` routines.
- `maskSecrets()` caches key→mask pairs; invalidate via `invalidateSecretMaskCache()` wherever keys are inserted/deleted.
- Cookie names (`ai_studio_proxy_dashboard`/`_csrf`) and localStorage keys (`ai_studio_proxy_*`) are load-bearing identifiers renamed during the project rebrand — renaming them logs users out.

## Stability policy (real users are live)

The app is past initial testing and running for real users. Every change must be non-destructive: never break the app's availability and never lose or corrupt existing data.

- Never delete, overwrite, or corrupt existing application data.
- Preserve fixed deployment defaults, cookie/localStorage names, API routes, and response shapes; breaking changes require explicit owner approval.
- Before pushing storage or startup changes, validate a clean Compose boot with a new `./volumes` directory and both health endpoints.
- If a change could discard or corrupt data, stop and ask the owner first.

## Naming & docs conventions

- Known accepted trade-offs: CSP allows `'unsafe-inline'` scripts (dashboard panels are injected with inline handlers); routing selection is per Gemini key and model while usage reports retain both Gemini and client attribution; `dashboard/` assets are read and cached on first request, so UI edits need a restart. Don't "fix" these silently — they're owner-approved.
- Repo is `ai_studio_proxy` (underscores); Docker image/service/container are `ai-studio-proxy` (hyphens); internal identifiers use underscores. Default port is 9009.
- README and all UI copy must state facts that match current behavior — the owner audits both for accuracy. Use neutral product language ("optional", purpose-first descriptions); no conversational phrasing that references feature requests or implementation history.
- Deploy = push to `origin/main` (GHCR workflow publishes `latest`; semver tags on `v*.*.*`). The owner's standing workflow: review, test, then push after finishing.
