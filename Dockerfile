# ─── build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY drizzle.config.ts ./
COPY src ./src
RUN npm run build

# ─── runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Kolkata

# libc compat + tini for proper signal handling
RUN apk add --no-cache tini curl \
    && addgroup -S orbit -g 10001 \
    && adduser -S orbit -u 10001 -G orbit

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# compiled application + SQL migrations (runtime reads drizzle/*.sql)
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

USER orbit

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# migrations run first (idempotent), then the app
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/index.js"]
