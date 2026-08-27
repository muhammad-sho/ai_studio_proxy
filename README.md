# AI Studio Proxy

A self-hosted proxy that pools multiple Google Gemini API keys behind one endpoint. Point any Gemini-compatible app at it instead of Google — it handles key selection, rate limits, and cooldowns automatically.

---

## How It Works

```
Your App  ──▶  AI Studio Proxy  ──▶  Google Gemini API
                (your server)
```

**Two things change:**

| | Before (direct to Google) | After (through proxy) |
|---|---|---|
| **URL** | `https://generativelanguage.googleapis.com` | `http://YOUR_SERVER:9009` |
| **Key** | Your Google API key | Client key from the dashboard |

Everything else stays the same — same request format, same response, same SDK.

---

## Quick Start

### 1. Start the proxy

```bash
mkdir ai-studio-proxy && cd ai-studio-proxy
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/muhammad-sho/ai_studio_proxy/main/docker-compose.yml
docker compose up -d
```

### 2. Set it up

1. Open `http://YOUR_SERVER_IP:9009`
2. Create your admin account
3. Add your Gemini API keys (paste one or many)
4. Generate a client key

### 3. Use it

Replace `https://generativelanguage.googleapis.com` with `http://YOUR_SERVER_IP:9009` in any tool or SDK.

---

## API Usage

**Any tool that works with Gemini works with this proxy.** Just follow the official Google Gemini API docs and make two changes:

1. **Replace the base URL:**

```
https://generativelanguage.googleapis.com  →  http://YOUR_SERVER_IP:9009
```

2. **Replace the API key header:**

```
x-goog-api-key: YOUR_GOOGLE_KEY  →  x-proxy-api-key: YOUR_CLIENT_KEY
```

### Examples

**curl:**

```bash
# Before (direct to Google)
curl https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-goog-api-key: YOUR_GOOGLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'

# After (through proxy)
curl http://YOUR_SERVER_IP:9009/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-proxy-api-key: YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'
```

**Python:**

```python
# Before
import google.generativeai as genai
genai.configure(api_key="YOUR_GOOGLE_KEY")
model = genai.GenerativeModel("gemini-2.5-flash")

# After — just change the API endpoint
import google.generativeai as genai
genai.configure(
    api_key="YOUR_CLIENT_KEY",
    client_options={"api_endpoint": "YOUR_SERVER_IP:9009"}
)
model = genai.GenerativeModel("gemini-2.5-flash")
```

**OpenAI-compatible clients:**

```python
# Any client that supports a custom base URL
client = OpenAI(
    api_key="YOUR_CLIENT_KEY",
    base_url="http://YOUR_SERVER_IP:9009/v1beta/openai/"
)
```

### What's supported

All endpoints, all methods, all content types — just like Google:

- `generateContent`, `streamGenerateContent` (SSE streaming works)
- `countTokens`, `embedContent`, `batchEmbedContents`
- File uploads (`/upload/v1beta/files`)
- Text, images, audio, video — anything you can send to Gemini
- Versions: `v1`, `v1beta`, `v1alpha` — all work

---

## Dashboard

Open `http://YOUR_SERVER_IP:9009` to manage everything:

| Tab | What It Shows |
|---|---|
| **Overview** | Key counts, model count, requests today, cooldown status, per-model usage matrix |
| **Gemini API Keys** | Add/remove Google keys, per-key usage stats |
| **Client Keys** | Generate keys for your apps, per-key usage stats |
| **Request Logs** | Every request with time, model, key, status — click for full details |
| **Statistics** | Success rates and failure reasons by model |

---

## Key Selection

The proxy picks the key with **fewest successful requests** for that model today — not round-robin. This keeps usage balanced across all your keys.

**Cooldowns:**

| What happens | What the proxy does |
|---|---|
| Rate limit (429) or server error (5xx) | Bench that key for 60 seconds |
| Daily quota exceeded | Bench until midnight Pacific |

All keys reset at midnight Pacific automatically — no restart needed.

---

## Environment Variables

All optional. Configure in `docker-compose.yml` or `.env`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9009` | Port the proxy listens on |
| `DB_PATH` | `./ai-studio-proxy.db` | SQLite database location |
| `DEBUG` | off | Set to `1` for detailed trace logging |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy |
| `REQUEST_TIMEOUT_MS` | `120000` | Upstream timeout (ms) |
| `MAX_BODY_BYTES` | `52428800` | Max request body size (50 MB) |
| `MAX_LOG_ENTRIES` | `1000` | Max request logs kept (older pruned) |
| `LOG_BODY_MAX_BYTES` | `65536` | Max payload stored per log entry |
| `MODELS_CACHE_TTL_HOURS` | `24` | Hours before model list refreshes |

---

## Docker Commands

```bash
docker compose up -d          # Start
docker compose down            # Stop
docker compose restart         # Restart
docker compose pull && docker compose up -d   # Update to latest
docker compose logs -f         # View logs
```

---

## Troubleshooting

**401 Unauthorized** — Your request is missing the `x-proxy-api-key` header or the key is invalid. Generate a new one in the dashboard under **Client Keys**.

**503 No keys configured** — No Gemini API keys are set up. Add at least one in **Gemini API Keys**.

**Rate limit errors** — The affected key is automatically benched for 60 seconds. The dashboard shows which keys are cooling down.

**Connection refused** — Make sure the proxy container is running (`docker compose ps`) and you're connecting to the right port.

---

## Security Notes

- Gemini API keys are stored in the database in plaintext (the proxy needs them to authenticate with Google)
- Client keys authenticate your apps with the proxy
- Protect the database file — it contains all your keys
- Do not expose port `9009` directly to the internet — use a reverse proxy or VPN

---

[GitHub Repository](https://github.com/muhammad-sho/ai_studio_proxy)
