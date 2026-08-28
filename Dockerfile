FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache su-exec \
    && mkdir -p /data
COPY server.js ./server.js
COPY lib/ ./lib/
COPY dashboard/ ./dashboard/
COPY setup.html ./setup.html
COPY signin.html ./signin.html
COPY reset-password.html ./reset-password.html
COPY --chmod=755 entrypoint.sh ./entrypoint.sh

EXPOSE 9009 9008
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO /dev/null "http://127.0.0.1:9009/health" && wget -qO /dev/null "http://127.0.0.1:9008/health" || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
