# Deployment guide

## Start the service

The Compose file works with no configuration:

```bash
curl -fsSLO https://raw.githubusercontent.com/muhammad-sho/ai_studio_proxy/main/docker-compose.yml
docker compose up -d
```

It stores the SQLite database in `./volumes` on the host and exposes the dashboard on port `9009` and API on port `9008`.

## Optional tuning

The Compose file includes an empty `environment` section with two commented examples. Add or uncomment only the settings you need there, using `.env.example` as the complete reference, then restart the service:

```bash
docker compose up -d
```

Invalid values safely use the built-in default.

## Production settings

- Terminate TLS at a reverse proxy.
- Keep `./volumes` private and back it up regularly.
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
