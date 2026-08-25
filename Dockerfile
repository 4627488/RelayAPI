FROM node:24-alpine AS web-build
WORKDIR /web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY web/ ./
ARG VITE_GIT_COMMIT=dev
ENV VITE_GIT_COMMIT=$VITE_GIT_COMMIT
RUN pnpm build

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
COPY third_party/cpaexecutor/go.mod third_party/cpaexecutor/go.sum ./third_party/cpaexecutor/
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/relayapi ./cmd/relayapi

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/relayapi /relayapi
COPY --from=web-build /web/dist /web
ENV RELAY_WEB_DIST_DIR=/web
EXPOSE 3000
ENTRYPOINT ["/relayapi"]
