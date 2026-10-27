# syntax=docker/dockerfile:1

# Node 22 LTS. Pin a newer patch here when upgrading.
ARG NODE_IMAGE=node:22-alpine

# ---- 1. Production dependencies only ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- 2. Pre-compress the static assets (8.7 MB of polling-unit JSON -> ~2 MB brotli) ----
FROM ${NODE_IMAGE} AS assets
WORKDIR /app
COPY scripts/precompress.js scripts/precompress.js
COPY public public
RUN node scripts/precompress.js

# ---- 3. Runtime ----
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
COPY --from=deps --chown=root:root /app/node_modules node_modules
COPY --chown=root:root package.json *.js ./
COPY --chown=root:root migrations migrations
COPY --chown=root:root scripts/migrate.js scripts/migrate.js
COPY --from=assets --chown=root:root /app/public public

# Code is owned by root and read-only to the app user; the app writes nothing to disk.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
