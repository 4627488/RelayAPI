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

FROM golang:1.27.3-alpine AS go-source
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
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

FROM alpine:3.22 AS runtime
RUN apk add --no-cache ca-certificates && adduser -D -u 1000 relay
# Independent layers keep unchanged launcher assets reusable across releases.
COPY --link --from=artifacts /relayapi /relayapi
COPY --link --from=artifacts /rai-bin /rai-bin
COPY --link --from=artifacts /web /web
ENV RELAY_WEB_DIST_DIR=/web
ENV RELAY_RAI_BIN_DIR=/rai-bin
USER relay
EXPOSE 3000
ENTRYPOINT ["/relayapi"]
