# syntax=docker/dockerfile:1
# Drinking Buddies — production image.
#   docker build -t drinking-buddies .
#   docker run --env-file .env -p 3000:3000 drinking-buddies
# Needs Postgres (DATABASE_URL), Redis (REDIS_URL) and S3-compatible photo storage (S3_*);
# see compose.yaml for a complete single-server setup. Pin the base image by digest for
# fully reproducible builds (docker buildx imagetools inspect node:22-bookworm-slim).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- dependencies (production only, exactly as locked) ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    STORAGE_DIR=/app/data/photos \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app

# App code only (see .dockerignore). Files stay root-owned and read-only to the app user;
# the only writable place is /app/data (local photo driver / dev secrets), meant for a volume.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./
COPY lib ./lib
COPY db ./db
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data

USER node
EXPOSE 3000
VOLUME ["/app/data"]

# Liveness: the app answers /api/health once Postgres is reachable (Redis/storage status is reported in the body).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# node runs as PID 1 and handles SIGTERM itself (stops accepting requests, closes DB/Redis, exits).
# Database migrations run automatically at startup (advisory-locked, safe with several replicas).
STOPSIGNAL SIGTERM
CMD ["node", "server.js"]
