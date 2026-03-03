# ── Stage 1: Install dependencies ────────────────────────────────────────
FROM node:18-bullseye-slim AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 2: Production image ───────────────────────────────────────────
FROM node:18-bullseye-slim AS production

# Security: run as non-root
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

WORKDIR /app

# Copy only production deps and source
COPY --from=deps /app/server/node_modules server/node_modules
COPY server/ server/

# Security: restrict file permissions
RUN chown -R appuser:appuser /app && chmod -R 550 /app

USER appuser

# Configuration
ENV PORT=3000 \
  NODE_ENV=production \
  LOG_LEVEL=info \
  MAX_PAYLOAD_SIZE=10mb \
  GRACEFUL_SHUTDOWN_TIMEOUT=10000

EXPOSE 3000

# Health check for container orchestrators
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw new Error();process.exit(0)}).catch(()=>process.exit(1))"

# Use exec form for proper signal handling (SIGTERM)
CMD ["node", "server/index.js"]

# Labels for container registry
LABEL org.opencontainers.image.title="strawberry-github-app" \
  org.opencontainers.image.description="GitHub App webhook receiver for Strawberry orchestration" \
  org.opencontainers.image.source="https://github.com/SinghSudhanshul/strawberry-github-app" \
  org.opencontainers.image.vendor="Strawberry"
