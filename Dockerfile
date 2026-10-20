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
# bookworm (glibc) rather than alpine (musl): the bundled JobSpy scraper
# needs python wheels (pandas, curl_cffi) that publish reliably for glibc.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Kolkata

# tini for proper signal handling; python venv for the in-house JobSpy CLI
# (pilot: Indeed + Naukri). Pinned upstream version for reproducible images.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini curl python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/jobspy \
    && /opt/jobspy/bin/pip install --no-cache-dir "python-jobspy==1.4.0" \
    && /opt/jobspy/bin/jobspy --version \
    && chmod -R a+rX /opt/jobspy
ENV PATH="/opt/jobspy/bin:${PATH}"

RUN groupadd -g 10001 orbit \
    && useradd -r -u 10001 -g orbit -d /app -s /usr/sbin/nologin orbit

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# compiled application + SQL migrations (runtime reads drizzle/*.sql)
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle

USER orbit

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
# migrations run first (idempotent), then the app
CMD ["sh", "-c", "node dist/database/migrate.js && node dist/index.js"]
