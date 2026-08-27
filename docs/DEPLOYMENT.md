# Deployment guide

Docker Compose 2.24 or newer is required for the optional `.env` file support.

## Start the service

The Compose file works with no configuration:

```bash
curl -fsSLO https://raw.githubusercontent.com/muhammad-sho/ai_studio_proxy/main/docker-compose.yml
docker compose up -d
```

It stores the SQLite database in `./volumes` on the host and exposes the dashboard on port `9009` and API on port `9008`.

## Optional tuning

Only create `.env` when a default needs changing:

```bash
curl -fsSLO https://raw.githubusercontent.com/muhammad-sho/ai_studio_proxy/main/.env.example
cp .env.example .env
```

Commented settings in `.env.example` leave the app defaults unchanged. Compose ports are fixed at `9009` (dashboard) and `9008` (API).

## Production settings

- Set `CORS_ORIGIN` to the exact browser origin when browser clients call the proxy directly.
- Set `TRUST_PROXY=1` only when a trusted reverse proxy overwrites forwarded client-address headers.
- Terminate TLS at a reverse proxy.
- Keep `DB_PATH` as an absolute file path inside the mounted `/data` directory; the default is `/data/ai-studio-proxy.db`.
- On SELinux hosts, append `:Z` to the `./volumes:/data` mount in `docker-compose.yml`.

## Verify and operate

```bash
docker compose ps
curl --fail http://127.0.0.1:9009/health
curl --fail http://127.0.0.1:9008/health
docker compose logs --tail=100 ai-studio-proxy
```

The container reports healthy only when both the dashboard and API listeners respond.

## Upgrade

```bash
docker compose pull
docker compose up -d
```

## Backup

Stop the service before copying the bind-mounted `./volumes` directory so the SQLite database and WAL sidecars remain consistent:

```bash
docker compose stop
tar -czf ai-studio-proxy-volumes-backup.tgz volumes
docker compose start
```
