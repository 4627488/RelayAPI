# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS web-builder
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web ./
RUN npm run build

FROM rust:1.88-alpine AS builder
WORKDIR /app
RUN apk add --no-cache build-base ca-certificates pkgconfig
COPY Cargo.toml ./
COPY Cargo.lock ./
COPY server ./server
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    cargo build --release -p relay-api-server && \
    cp target/release/relay-api-server /relay-api-server

FROM alpine:3.22 AS runner
WORKDIR /app
RUN apk add --no-cache ca-certificates \
    && adduser -D -H -u 1001 relay \
    && mkdir -p /app/data /app/web \
    && chown -R relay:relay /app/data /app/web
COPY --from=builder /relay-api-server /usr/local/bin/relay-api-server
COPY --from=web-builder /app/dist /app/web
USER relay
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV RELAY_STATIC_DIR=/app/web
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD /usr/local/bin/relay-api-server --healthcheck || exit 1
CMD ["relay-api-server"]
