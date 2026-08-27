# Deployment guide

## Start the service

Use Docker Compose with the published image:

```bash
curl -fsSLO https://raw.githubusercontent.com/muhammad-sho/ai_studio_proxy/main/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/muhammad-sho/ai_studio_proxy/main/.env.example
cp .env.example .env
docker compose config --quiet
docker compose up -d
```

The default data directory is `./data`. It contains the SQLite database and must be backed up before changing hosts.

## Production settings

- Set `CORS_ORIGIN` to the exact browser origin when browser clients call the proxy directly.
- Set `TRUST_PROXY=1` only when a trusted reverse proxy overwrites forwarded client-address headers.
- Terminate TLS at a reverse proxy. Keep the proxy container on its two default ports unless you intentionally change both `ADMIN_PORT` and `API_PORT`.
- Do not put `DB_PATH` at the container root. It must be an absolute file path inside a writable mounted directory; the default is `/data/ai-studio-proxy.db`.
- Docker logs are capped at 10 MiB per file with three retained files. Use your platform logging driver if central log collection is required.

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

Stop the service before copying the bind-mounted `./data` directory so the SQLite database and WAL sidecars remain consistent:

```bash
docker compose stop
tar -czf ai-studio-proxy-data-backup.tgz data
docker compose start
```
