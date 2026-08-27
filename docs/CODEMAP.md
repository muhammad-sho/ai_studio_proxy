# Code map

This repository is intentionally dependency-free. Keep Node.js built-ins, SQLite, the two-port design, and the public API contract.

## Stable runtime map

| Area | Owner | Change it when |
|---|---|---|
| Process startup, port binding, shutdown | `server.js` | Changing how the application starts or stops |
| Environment defaults and limits | `lib/config.js` | Adding or validating an environment setting |
| SQLite schema, startup, statement cache | `lib/database.js` | Changing storage setup or fixed SQL ownership |
| HTTP primitives and security headers | `lib/http.js` | Changing JSON responses, headers, body limits, or static HTTP behavior |
| Dashboard login, cookies, CSRF, rate limits | `lib/auth.js` | Changing dashboard authentication |
| Route families and Gemini path parsing | `lib/routing.js` | Changing which port owns a path |
| Dashboard/admin API endpoints | `lib/admin-routes.js` | Changing setup, keys, logs, statistics, or dashboard APIs |
| Usage, key ordering, cooldowns, retention | `lib/usage.js` | Changing quota accounting or key selection |
| Gemini forwarding, uploads, streams, models | `lib/gemini-proxy.js` | Changing upstream pass-through behavior or latency |
| Dashboard file loading, compression, and revalidation | `lib/dashboard-assets.js` | Changing dashboard static assets or their cache policy |
| Dashboard UI | `dashboard/` | Changing presentation, lazy panel loading, or a panel controller |
| Contract tests | `test/` | Adding a guard for a behavior or forwarding change |

## Module exports

| File | Entry point | Owns |
|---|---|---|
| `server.js` | application bootstrap | Dependency assembly, listeners, shutdown, hourly sweep |
| `lib/config.js` | `loadConfig()` | Environment defaults and limits |
| `lib/database.js` | `createDatabase()` | SQLite instance, schema, prepared-statement cache |
| `lib/http.js` | `createHttpHelpers()` | JSON output, security headers, bounded body reads |
| `lib/auth.js` | `createAuth()` | Sessions, CSRF, client-key lookup, login throttling |
| `lib/routing.js` | route parsing exports | Path parsing, port-family gate, usage model naming |
| `lib/dashboard-assets.js` | `createDashboardAssets()` | Authenticated dashboard assets, gzip, ETags, and private revalidation |
| `lib/usage.js` | `createUsage()` | Pacific periods, selection statistics, cooldowns, retention, masking |
| `lib/gemini-proxy.js` | `createGeminiProxy()` | Upstream forwarding, successful-response streaming, uploads, and model refresh |
| `lib/admin-routes.js` | `createRequestHandler()` | Setup, login, dashboard APIs, key CRUD, route dispatch |

Every module is initialized once by `server.js`. Modules receive dependencies as arguments; they must not import the bootstrap file or reach into another module's private state.

Dashboard modules follow the same boundary: `dashboard/dashboard.js` owns shell, authentication-aware fetches, navigation, and shared modals; a panel HTML file owns markup; its optional sibling `.js` file owns that panel's lazy controller. Keep a controller loaded only after its panel HTML is present.

## Public contract

- Admin routes stay on `ADMIN_PORT`; Gemini-compatible API and upload routes stay on `API_PORT`; `/health` stays on both.
- Published environment variables, cookie names, local-storage names, API paths, methods, and response properties stay stable.
- Every proxy request uses exactly one selected Gemini key. Do not add retries, fallback attempts, or request/response rewriting.
- Usage stays permanently retained, including after keys are deleted. Request logs remain separately retained under their existing policy.
- Dashboard assets and admin endpoints require a valid dashboard session. State-changing admin requests also require CSRF validation.

## Request flow

```text
listener → route-family gate → request handler
  admin: authentication → admin route → SQLite
  api: client-key auth → key selection → Gemini forwarder → success stream or classified error → usage/log recording
```

## Where to debug

| Symptom | Start here | Then check |
|---|---|---|
| Wrong port returns a route | `lib/routing.js` | `test/smoke.test.js` route-family test |
| Dashboard cannot sign in | `lib/auth.js` | setup/login test and cookie names |
| Dashboard tab has stale data | `dashboard/dashboard.js` and `dashboard/panels/` | `lib/admin-routes.js` usage scope |
| Wrong key was selected | `lib/usage.js` | usage/cooldown tests |
| Gemini response differs from upstream | `lib/gemini-proxy.js` | `test/gemini-proxy.test.js` and smoke tests |
| Statistics are missing | `lib/usage.js` | retained-usage test |
| Container starts but app is unavailable | `Dockerfile`, `entrypoint.sh` | CI container-start smoke check |

## Refactoring rule

Each extracted module keeps the same inputs and outputs as the corresponding current code. Do not combine an extraction with a behavior change. Add or update a test first, extract one ownership area, then verify the route contract and full test suite before the next area.
