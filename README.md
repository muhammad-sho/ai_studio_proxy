# AI Studio Proxy

A self-hosted Gemini API proxy that pools multiple Google Gemini API keys behind one stable endpoint. It picks the best available key for every request, handles rate limits and cooldowns automatically, and speaks the standard Gemini API — so any app that can call Gemini can use it without changes.

## Features

* Multiple Gemini API keys pooled behind one proxy endpoint
* **Best-key selection, best-to-worst** — ready keys first (least-used rotation per model); if none are ready, the least-bad key is tried anyway, starting with the soonest-expiring cooldown
* Automatic retry on another key when one fails
* Automatic cooldown when a key is overloaded or out of daily quota
* Google's responses — successes and errors alike — are relayed to the client exactly as received
* Per-key and per-model usage tracking in a web dashboard
* Automatic model discovery from Google, served from a local cache so `/v1beta/models` answers instantly
* Web dashboard for managing keys, usage, cooldown status, and full request logs with payload inspection
* SQLite storage — no external database needed
* Docker and Docker Compose support
* Simple API authentication with your own proxy API keys

---

## How It Works

The proxy sits between your application and Google's Gemini API:

```text
┌──────────────┐
│   Your App   │
│  (any tool)  │
└──────┬───────┘
       │
       │ Gemini API request
       │ x-proxy-api-key: <client key>
       ▼
┌──────────────────────┐
│   AI Studio Proxy    │
│                      │
│  Auth check          │
│  Key selection       │
│  Retry / cooldown    │
└──────────┬───────────┘
           │
     ┌─────┼─────┬─────┐
     ▼     ▼     ▼     ▼
   Key 1  Key 2  Key 3  Key 4
     │     │     │     │
     └─────┴─────┴─────┴─────┘
              │
              ▼
      Google Gemini API
```

Your application only needs to know the proxy URL and **one client API key**
(generated in the dashboard). The real Google keys stay on your server.

---

# Quick Start (Docker Compose)

You only need Docker installed.

## 1. Get the compose file and start

```bash
mkdir ai-studio-proxy && cd ai-studio-proxy
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/muhammad-sho/ai_studio_proxy/main/docker-compose.yml
docker compose up -d
```

This pulls the published image:

```text
ghcr.io/muhammad-sho/ai-studio-proxy:latest
```

> The image is built automatically after every push to `main`. A brand-new
> repository must wait until that first build succeeds before pulling works.
> Version tags are also published for `v*.*.*` releases.

Check the logs:

```bash
docker compose logs -f
```

The dashboard will be available on:

```text
http://YOUR_SERVER_IP:9009
```

## 2. First-time setup

1. Open `http://YOUR_SERVER_IP:9009`.
2. Create your administrator account (username + password of at least 8
   characters), then sign in. The setup page is only shown until an
   administrator exists — complete it right after starting the container,
   since anyone who can reach the server before you could create the account
   instead.
3. Open **Gemini API Keys** and add your Google Gemini keys.
4. Open **Client Keys** and generate a key for your application. Every key has
   a **Copy Key** button, so you can copy it again anytime.

Done — start sending requests.

### Run from source instead (development)

```bash
git clone https://github.com/muhammad-sho/ai_studio_proxy.git
cd ai_studio_proxy
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

Or run directly with Node.js 22+ (no packages to install):

```bash
node server.js
```

---

# Upgrading from `gemini-proxy`

This project was formerly published as **Gemini Proxy** with the image
`ghcr.io/muhammad-sho/gemini-proxy`. Existing deployments keep running, but
switch once so `docker compose pull` follows the new name:

1. Update your `docker-compose.yml` (a fresh copy already contains these):
   service and container `gemini-proxy` → `ai-studio-proxy`, image
   `ghcr.io/muhammad-sho/gemini-proxy:latest` →
   `ghcr.io/muhammad-sho/ai-studio-proxy:latest`, and `DB_PATH`
   `/data/local-gemini-proxy.db` → `/data/ai-studio-proxy.db`.
2. Run `docker compose pull && docker compose up -d`.
3. Your database moves with you: when `DB_PATH` is left at its default, the
   container automatically renames `/data/local-gemini-proxy.db` (plus its
   `-wal`/`-shm` sidecars) on first start. With a custom `DB_PATH`, rename the
   file yourself before upgrading.
4. Running from source without `DB_PATH`: run
   `mv local-gemini-proxy.db ai-studio-proxy.db` in the project directory, or
   set `DB_PATH=./local-gemini-proxy.db`.
5. Dashboard cookies and saved UI preferences got new names, so you are
   signed out once and the chosen theme/tab resets.

---

# Dashboard

Open `http://YOUR_SERVER_IP:9009` and sign in. The dashboard has four tabs:

| Tab | What it does |
| --- | --- |
| **Overview & Usage** | Totals (client keys, Gemini keys, models, requests today), reset schedule, model sync time, plus the per model/key usage table with cooldown states |
| **Gemini API Keys** | Add and remove your Google Gemini keys |
| **Client Keys** | Generate and manage the API keys your applications use |
| **How to Use** | Copy-paste API examples for calling the proxy |
| **Request Logs** | Every generation attempt with time, model, key, attempt number, and result. Filter by model/result or search; click a row to inspect the exact request/response payloads (API keys masked) |

Add your Google keys through the dashboard instead of pasting them directly
into your applications or workflows.

---

# API Usage

The proxy exposes the Gemini API using the standard Gemini request format.
Point any Gemini-compatible app at the proxy and swap two things: the URL and
the key.

Supported endpoints: `GET /v1beta/models` (list models) and
`POST /v1beta/models/{model}:generateContent`. Streaming responses
(`streamGenerateContent`) and `countTokens` are not proxied.

```bash
curl http://127.0.0.1:9009/v1beta/models/gemini-2.0-flash:generateContent \
  -H "Content-Type: application/json" \
  -H "x-proxy-api-key: YOUR-CLIENT-KEY" \
  -d '{
    "contents": [
      {
        "parts": [
          {
            "text": "Say hello"
          }
        ]
      }
    ]
  }'
```

The response is Google's response, unchanged. Your app never sees which
Google key handled the request.

---

# Key Selection

The proxy does **not** rotate round-robin. For each model it selects the key
with the **fewest successful requests since the current daily window began**,
so all your keys are consumed evenly:

```text
Key usage today for gemini-2.0-flash:
  Key 1: 40   Key 2: 35   Key 3: 35   ← next request goes here
```

Usage is tracked per **model + key** combination, independently:

```text
Key 1 + gemini-2.0-flash
Key 1 + gemini-2.0-flash-lite
Key 2 + gemini-2.0-flash
Key 2 + gemini-2.0-flash-lite
```

A limit reached on one combination never affects the others. Only successful
requests count — failures do not.

At every reset moment (midnight Pacific time) the proxy clears the previous
day's usage records and expires finished cooldowns, so all keys start the new
day at zero automatically — no restart needed.

---

# Cooldowns and Retries

When a key fails, the proxy marks that model/key combination unavailable,
picks another key, and retries:

| Failure | Cooldown |
| --- | --- |
| Overload / rate-limit / server errors (408, 429, 5xx) | 60 seconds |
| Daily quota exceeded | Until Gemini's next midnight Pacific reset |

This prevents a temporarily limited key from repeatedly receiving requests.

---

# Models

Models are **not** configured manually. The model list is discovered from
Google and **cached locally**, so calls to `GET /v1beta/models` (like the ones
n8n makes during setup) return instantly instead of waiting for Google.

* First call with no cache: fetches from Google once, then caches.
* Every later call: served from cache — no delay.
* The cache refreshes itself in the background when it gets older than 24
  hours (`MODELS_CACHE_TTL_HOURS`, see settings). Your request is never
  delayed by a refresh.
* Want to force it? Use the **Refresh** button next to *Model Sync* on the
  dashboard's Overview tab.

The proxy also removes models that Google no longer offers and records the
sync time shown in the dashboard.

Removing a model from the list never deletes its usage history: if Google
temporarily drops a model, its per-key usage and cooldown data stay visible
until the normal daily reset clears them, and requests to that model are
still forwarded to Google (Google decides whether to serve it).

---

# Database

The proxy uses SQLite (stored at `./data/ai-studio-proxy.db` next to your
`docker-compose.yml`) to persist:

* Administrator account
* Client API keys
* Gemini API keys
* Usage records and cooldown state

The directory is mounted as a bind mount by Docker Compose, survives restarts
and image upgrades, and needs no manual permission fixes. Back up the `data/`
folder to back up everything.

Do not delete the database unless you intentionally want to reset the proxy's
stored state.

---

# Environment Variables

All configuration is optional; normal operation needs nothing beyond the
dashboard setup. Add these to the `environment:` section of
`docker-compose.yml` if needed:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `9009` | Port the proxy listens on |
| `DB_PATH` | `/data/ai-studio-proxy.db` | SQLite database location inside the container |
| `DEBUG` | unset | Set to `1` for extra per-attempt debug logging |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy to honor `X-Forwarded-For` |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream request timeout |
| `KEY_LOOP_DEADLINE_MS` | same as `REQUEST_TIMEOUT_MS` | Total time budget for trying keys one-by-one on a failed request before giving up |
| `KEY_FALLBACK_ATTEMPTS` | `2` | How many different Gemini keys a single request may try before Google's last response is relayed to the client exactly as received |
| `MAX_LOG_ENTRIES` | `1000` | Maximum request-log entries kept in the database (oldest pruned automatically) |
| `LOG_BODY_MAX_BYTES` | `65536` | Per side (request/response) payload size kept per log entry; larger payloads are truncated |
| `MAX_BODY_BYTES` | `10485760` | Maximum accepted request body size |
| `MAX_RESPONSE_BYTES` | `52428800` | Maximum forwarded response size |
| `MODELS_CACHE_TTL_HOURS` | `24` | Hours before the cached model list refreshes in the background |

Logging: every request, upstream call, key rotation decision, auth event and admin action is written to stdout with a timestamp. Secrets (API keys, passwords, tokens) are always masked. Set `DEBUG=1` for extra per-attempt trace logging.

See `.env.example` for a starting point.

---

# Docker Commands

Start:

```bash
docker compose up -d
```

Update to the latest image (data is kept):

```bash
docker compose pull && docker compose up -d
```

View logs:

```bash
docker compose logs -f
```

Stop:

```bash
docker compose down
```

Restart:

```bash
docker compose restart
```

---

# Security

API requests require a valid client key sent as:

```text
x-proxy-api-key: YOUR-CLIENT-KEY
```

Passwords are stored hashed (scrypt); client API keys are stored in the
database so the dashboard can redisplay them via their Copy button — protect
the database like you would the keys themselves. Sign-in is protected by
session cookies, CSRF tokens, and login rate limiting.

Google Gemini API keys are stored in the local SQLite database in plaintext
because the proxy must recover them to authenticate upstream. Protect the
server and back the database up securely.

Do not expose port `9009` straight to the public internet. Put it behind an
HTTPS reverse proxy or keep it on a trusted network / VPN.

---

# Troubleshooting

## 401 Unauthorized

Check that the request contains the `x-proxy-api-key` header and that the
value matches a client key generated in the dashboard (**Client Keys** tab).

## 503 No Gemini API keys

No Google keys are configured at all. Add at least one key in the
**Gemini API Keys** tab — cooled-down keys are still tried automatically,
so this only appears with an empty pool.

## Rate Limit Errors

Check the dashboard for the affected model/key combination. The proxy already
rotated to another available key when possible.

## Database Is Read-Only

Make sure the directory containing the SQLite database is writable by the
container. The provided Compose file handles this automatically, including on
SELinux hosts via the `:Z` mount label.

---

# Project

Repository:

https://github.com/muhammad-sho/ai_studio_proxy
