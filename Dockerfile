FROM node:24-alpine AS web-build
WORKDIR /web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/relayapi ./cmd/relayapi

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/relayapi /relayapi
COPY --from=web-build /web/dist /web
ENV RELAY_WEB_DIST_DIR=/web
EXPOSE 3000
ENTRYPOINT ["/relayapi"]
