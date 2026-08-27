FROM node:24-alpine AS web-build
WORKDIR /web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
ARG VITE_GIT_COMMIT=dev
ENV VITE_GIT_COMMIT=$VITE_GIT_COMMIT
RUN pnpm build

FROM golang:1.26.6-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
COPY third_party/cpaexecutor/go.mod third_party/cpaexecutor/go.sum ./third_party/cpaexecutor/
RUN go mod download
COPY . .
ARG VITE_GIT_COMMIT=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/relayapi ./cmd/relayapi
RUN chmod +x scripts/build-rai-dist.sh && scripts/build-rai-dist.sh /out/rai-bin "$VITE_GIT_COMMIT"

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/relayapi /relayapi
COPY --from=build /out/rai-bin /rai-bin
COPY --from=web-build /web/dist /web
ENV RELAY_WEB_DIST_DIR=/web
ENV RELAY_RAI_BIN_DIR=/rai-bin
EXPOSE 3000
ENTRYPOINT ["/relayapi"]
