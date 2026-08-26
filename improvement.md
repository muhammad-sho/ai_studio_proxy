# Plan: Full Google AI API Compatibility

## Goal
Make the proxy a 100% compatible alternative to Google's Generative Language API (`generativelanguage.googleapis.com`), accepting every endpoint, method, and content type that Google accepts.

## Gap Analysis

### Currently working (already proxied)

Everything under `/{v1,v1beta,v1alpha}/...` that matches the URL pattern gets forwarded through `handleGeminiPassthrough` → `forwardToGemini`:

- **Models**: `list` (cached), `get`
- **Content generation**: `generateContent`, `streamGenerateContent` (SSE)
- **Token counting**: `countTokens`
- **Embeddings**: `embedContent`, `batchEmbedContents`, `asyncBatchEmbedContent`
- **Batch operations**: `batchGenerateContent`, batch CRUD
- **Cached content**: `create`, `get`, `list`, `patch`, `delete`
- **Files**: `list`, `get`, `delete`, `files:register`
- **Tuned models**: all CRUD + permissions
- **Auth tokens**: `create`
- **FileSearchStores**: all CRUD
- **Predict/PredictLongRunning**
- All v1alpha equivalents

### Gaps found

| # | Gap | Impact |
|---|---|---|
| 1 | **Upload endpoints** (`/upload/v1beta/files`, `/upload/v1alpha/files`) | File upload (multipart + resumable) completely broken — 404 |
| 2 | **Resumable upload URL rewrite** | After upload init, Google returns `X-Goog-Upload-URL` pointing to Google directly — client bypasses proxy for chunk uploads |
| 3 | **Response header forwarding** | `returnUpstream` only forwards 3 headers. Missing `X-Goog-Upload-URL`, `X-Goog-Upload-Status`, `Location`, etc. |
| 4 | **`PASS_THROUGH_ACTIONS` incomplete** | Only 3 actions. `embedContent`, `batchEmbedContents`, `predict`, etc. show as `model:action` in stats instead of just model name. |
| 5 | **No CORS/OPTIONS handling** | Browser-based clients can't make cross-origin requests. |

## Implementation Plan

### 1. Upload endpoint routing

**New function `parseUploadRoute(pathname)`** — matches `/upload/{v1,v1beta,v1alpha}/...` and returns `{ version, subpath }`.

**New route in `handleRequest`** — inserted before the `apiRoute` fallthrough. When matched, calls `handleGeminiPassthrough` with model=null, action=null. The existing `forwardToGemini` already rewrites the URL correctly (it copies `incomingUrl.pathname` to `upstreamUrl.pathname`), so `/upload/v1beta/files` gets forwarded to `https://generativelanguage.googleapis.com/upload/v1beta/files`.

This handles both:
- `POST /upload/v1beta/files` — simple multipart upload + resumable upload init
- `PUT /upload/v1beta/files?upload_id=...` — resumable upload chunks

### 2. Response header forwarding (blacklist approach)

**Replace the header whitelist** in `returnUpstream` with a blacklist of hop-by-hop headers. Forward ALL upstream response headers except hop-by-hop ones (`connection`, `keep-alive`, `transfer-encoding`, `te`, `trailer`, `proxy-authenticate`, `proxy-authorization`, `upgrade`).

Same change for the stream relay headers.

This ensures future Google headers (e.g., `X-Goog-Upload-URL`, `X-Goog-Upload-Status`, `X-Error-Message`) are automatically forwarded without code changes.

### 3. Upload URL rewrite for resumable uploads

**New helper `rewriteUploadUrl(uploadUrl, request)`** — replaces the hostname/port in Google's `X-Goog-Upload-URL` with the proxy's external hostname (derived from `X-Forwarded-Host` or `Host` header).

**Applied in two places:**
- In `returnUpstream` — before writing headers, check for `x-goog-upload-url` and rewrite it
- In the stream relay — same check before writing headers

This ensures the client's subsequent PUT requests for resumable upload chunks go through the proxy, not directly to Google.

### 4. CORS handling

**New preflight handler** in `handleRequest` — responds to `OPTIONS` requests on API paths with appropriate `Access-Control-Allow-*` headers. Configurable origin via `CORS_ORIGIN` env var (default: `*`).

**Add CORS headers** to all API responses — `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, `Access-Control-Max-Age`.

### 5. `PASS_THROUGH_ACTIONS` expansion

Add `embedContent`, `batchEmbedContents`, `asyncBatchEmbedContent`, `predict`, `predictLongRunning` to the set. Stats-only change: model names show correctly in the dashboard.

### 6. Env var additions

- `CORS_ORIGIN` — allowed origin for CORS (default: `*`)

## Files changed

- `server.js` — all changes (routing, headers, CORS, upload rewrite)
- `.env.example` — add `CORS_ORIGIN`

## What does NOT change

- `dashboard.html` — no UI changes
- `README.md` — no changes needed
- `AGENTS.md` — no contract changes
- Database schema — no changes
- Docker config — no changes
- Existing behavior for all currently-working endpoints — unchanged

## Verification

```bash
node --check server.js          # syntax
sh -n entrypoint.sh             # shell syntax
```

Functional tests:
```bash
# Boot on scratch port
PORT=18970 DB_PATH=/tmp/x2/db timeout 10 node server.js &
# Setup + login
curl -X POST localhost:18970/api/setup -H 'Content-Type: application/json' -d '{"username":"admin","password":"testpass123"}'
# Upload endpoint should NOT 404 anymore (will get Google's 400 with fake key)
curl -X POST localhost:18970/upload/v1beta/files -H 'x-goog-api-key: fake' -H 'Content-Type: application/json' -d '{"file":{"displayName":"test"}}'
# CORS preflight
curl -X OPTIONS localhost:18970/v1beta/models -H 'Origin: http://example.com' -H 'Access-Control-Request-Method: GET'
```
