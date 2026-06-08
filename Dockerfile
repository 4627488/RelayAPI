# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS deps
ARG TARGETPLATFORM
RUN apk add --no-cache g++ make python3
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store-${TARGETPLATFORM}-musl,target=/pnpm/store \
  pnpm install --frozen-lockfile --config.side-effects-cache=false

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/tmp/relayapi-build-data
RUN pnpm build

FROM node:24-alpine AS runner
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

RUN addgroup -S -g 1001 nodejs \
  && adduser -S -u 1001 -G nodejs nextjs \
  && mkdir -p /app/data \
  && chown -R nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "server.js"]
