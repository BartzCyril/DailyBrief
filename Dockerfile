# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-slim AS dependencies
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true PRISMA_SKIP_POSTINSTALL_GENERATE=true
COPY package.json bun.lock ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY shared/package.json shared/package.json
# Optional CA mounts support managed build environments without changing VPS trust.
RUN --mount=type=secret,id=proxy_ca \
    --mount=type=secret,id=system_ca \
    if [ -s /run/secrets/proxy_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/build-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca SSL_CERT_FILE=/tmp/build-ca.pem; \
    fi; \
    bun install --frozen-lockfile --ignore-scripts && rm -f /tmp/build-ca.pem

FROM dependencies AS build
COPY shared shared
COPY backend backend
COPY frontend frontend
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; \
    fi; \
    bun run --cwd backend db:generate && \
    bun -e 'const {createRequire}=require("node:module"); const {dirname,resolve}=require("node:path"); const {cpSync}=require("node:fs"); const req=createRequire("/app/backend/package.json"); cpSync(resolve(dirname(req.resolve("@prisma/client/package.json")),"../../.prisma/client"),"/generated-client",{recursive:true});' && \
    bun run --cwd frontend build

FROM oven/bun:${BUN_VERSION}-slim AS production-dependencies
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true PRISMA_SKIP_POSTINSTALL_GENERATE=true
COPY package.json bun.lock ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY shared/package.json shared/package.json
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/build-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca SSL_CERT_FILE=/tmp/build-ca.pem; \
    fi; \
    bun install --production --frozen-lockfile --ignore-scripts && rm -f /tmp/build-ca.pem

FROM oven/bun:${BUN_VERSION}-slim AS backend
USER root
WORKDIR /app
COPY --chown=bun:bun --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=bun:bun --from=production-dependencies /app/backend/node_modules ./backend/node_modules
COPY --chown=bun:bun --from=production-dependencies /app/shared/node_modules ./shared/node_modules
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun backend/package.json backend/package.json
COPY --chown=bun:bun backend/src backend/src
COPY --chown=bun:bun backend/scripts backend/scripts
COPY --chown=bun:bun backend/prisma backend/prisma
COPY --chown=bun:bun shared shared
COPY --chown=bun:bun --from=build /generated-client /tmp/generated-client
RUN bun -e 'const {createRequire}=require("node:module"); const {dirname,resolve}=require("node:path"); const {cpSync}=require("node:fs"); const req=createRequire("/app/backend/package.json"); cpSync("/tmp/generated-client",resolve(dirname(req.resolve("@prisma/client/package.json")),"../../.prisma/client"),{recursive:true});' && \
    rm -rf /tmp/generated-client && \
    mkdir -p /var/log/dailybrief && chown bun:bun /var/log/dailybrief
RUN --mount=type=secret,id=proxy_ca \
    if [ -s /run/secrets/proxy_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/build-ca.pem; \
      printf 'Acquire::https::CaInfo "/tmp/build-ca.pem";\n' > /etc/apt/apt.conf.d/99build-ca; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends \
      chromium ca-certificates fonts-liberation fonts-noto-core fonts-noto-color-emoji && \
    rm -rf /var/lib/apt/lists/* /tmp/build-ca.pem /etc/apt/apt.conf.d/99build-ca
ENV NODE_ENV=production \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROMIUM_HEADLESS=true \
    CHROMIUM_NO_SANDBOX=true \
    XDG_CACHE_HOME=/tmp/cache \
    XDG_CONFIG_HOME=/tmp/config \
    PUPPETEER_SKIP_DOWNLOAD=true
USER bun
EXPOSE 3000
CMD ["bun", "backend/scripts/container-start.ts", "api"]

FROM caddy:2.10.2-alpine AS web
COPY --from=build /app/frontend/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile
