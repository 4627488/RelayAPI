# syntax=docker/dockerfile:1
ARG BUILD_SOURCE=source

FROM node:24-alpine AS web-build
WORKDIR /web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@12.14.0 --activate
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
ARG VITE_GIT_COMMIT=dev
ENV VITE_GIT_COMMIT=$VITE_GIT_COMMIT
RUN pnpm build

FROM node:24-bookworm-slim AS cursor-base
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

FROM cursor-base AS cursor-build
COPY scripts/setup-cursor-runtime.mjs /setup-cursor-runtime.mjs
RUN node /setup-cursor-runtime.mjs /opt/relay-cursor

FROM golang:1.27.3-alpine AS go-source
WORKDIR /src
COPY go.mod go.sum ./
COPY third_party/cpaexecutor/go.mod third_party/cpaexecutor/go.sum ./third_party/cpaexecutor/
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY third_party/ ./third_party/
COPY scripts/build-rai-dist.sh ./scripts/build-rai-dist.sh

FROM go-source AS build
RUN CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags="-s -w" -o /out/relayapi ./cmd/relayapi

FROM go-source AS rai-build
RUN sh scripts/build-rai-dist.sh /out/rai-bin

FROM scratch AS source
COPY --from=build /out/relayapi /relayapi
COPY --from=rai-build /out/rai-bin /rai-bin
COPY --from=web-build /web/dist /web

# Release workflows compile once with persistent Go caches, then assemble here.
FROM scratch AS prebuilt
COPY .build/ /

FROM ${BUILD_SOURCE} AS artifacts

FROM cursor-base AS runtime
COPY --from=cursor-build /opt/relay-cursor /opt/relay-cursor
# Independent layers keep unchanged launcher assets reusable across releases.
COPY --link --from=artifacts /relayapi /relayapi
COPY --link --from=artifacts /rai-bin /rai-bin
COPY --link --from=artifacts /web /web
ENV RELAY_WEB_DIST_DIR=/web
ENV RELAY_RAI_BIN_DIR=/rai-bin
ENV RELAY_CURSOR_RUNTIME_DIR=/opt/relay-cursor
USER node
EXPOSE 3000
ENTRYPOINT ["/relayapi"]
