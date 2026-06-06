# syntax=docker/dockerfile:1.7

FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
RUN --mount=type=cache,id=bun-cache,target=/root/.bun/install/cache \
  bun install

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run build

FROM base AS runner
ARG OCI_CREATED
ARG OCI_REVISION
ARG OCI_SOURCE="https://github.com/4627488/RelayAPI"
ARG OCI_VERSION="dev"

LABEL org.opencontainers.image.title="RelayAPI" \
  org.opencontainers.image.description="Codex OAuth relay and OpenAI-compatible API management service" \
  org.opencontainers.image.source="${OCI_SOURCE}" \
  org.opencontainers.image.created="${OCI_CREATED}" \
  org.opencontainers.image.revision="${OCI_REVISION}" \
  org.opencontainers.image.version="${OCI_VERSION}"

WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/app/data

RUN addgroup -S nodejs -g 1001 \
  && adduser -S nextjs -u 1001 -G nodejs \
  && mkdir -p /app/data \
  && chown -R nextjs:nodejs /app/data

COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next

USER nextjs
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["bun", "run", "start"]
