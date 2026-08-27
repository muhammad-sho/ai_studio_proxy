# AI Studio Proxy

A self-hosted proxy that lets you use **multiple Google Gemini API keys through one endpoint and one client key**.

The proxy routes requests between your Gemini API keys and balances usage **per model**, following Google's per-model usage limits.

```text
Your App
   ↓
AI Studio Proxy
   ↓
Multiple Gemini API Keys
   ↓
Google Gemini API
```

## Quick Start

### Docker Compose

```bash
mkdir ai-studio-proxy && cd ai-studio-proxy

curl -fsSL -o docker-compose.yml \
  https://raw.githubusercontent.com/muhammad-sho/ai_studio_proxy/main/docker-compose.yml

docker compose up -d
```

### Docker CLI

```bash
docker run -d \
  --name ai-studio-proxy \
  -p 9009:9009 \
  -v ./ai-studio-proxy.db:/app/ai-studio-proxy.db \
  ghcr.io/muhammad-sho/ai_studio_proxy:latest
```

Then open:

```text
http://YOUR_SERVER_IP:9009
```

Add your Gemini API keys and create a client key.

That's it.

---

## Use It Like the Gemini API

Everything stays the same.

Just change the **URL**:

```text
https://generativelanguage.googleapis.com
```

to:

```text
http://YOUR_SERVER_IP:9009
```

Put your **client key** in the **same `x-goog-api-key` header** Google uses.

### Before

```bash
curl https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-goog-api-key: YOUR_GOOGLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'
```

### After

```bash
curl http://YOUR_SERVER_IP:9009/v1beta/models/gemini-2.5-flash:generateContent \
  -H "x-goog-api-key: YOUR_CLIENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"Hello"}]}]}'
```

Only the URL and the key value change — the request format stays identical to Google's.

Your application uses **one endpoint and one client key**, while the proxy routes requests across your Gemini API keys.

---

## Key Selection

For each model, the proxy selects the Gemini API key with the **lowest successful request count for that model today**.

This balances usage across your keys.

### Cooldowns

* **429 / 5xx:** key is paused for 60 seconds
* **Daily quota exceeded:** key is paused until midnight Pacific

Usage is counted **per model**, matching Google's model-specific usage limits.

---

## Dashboard

Open:

```text
http://YOUR_SERVER_IP:9009
```

The dashboard lets you:

* Manage Gemini API keys
* Create client keys
* View usage
* View cooldowns
* View request logs
* View statistics

---

## Repository

[GitHub Repository](https://github.com/muhammad-sho/ai_studio_proxy?utm_source=chatgpt.com)
