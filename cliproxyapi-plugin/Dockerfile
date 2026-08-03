FROM golang:1.26-bookworm AS build
ARG TARGETOS=linux
ARG TARGETARCH
ARG CPA_REF=4a315136730baa8b3a436d12b74e5a702c70be5c
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go quota.go quota-adapters.yaml ./
RUN CGO_ENABLED=1 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -buildmode=c-shared -trimpath -o /out/relayapi-bridge.so .

# CWSR is maintained with CPA and imports its plugin SDK through a local
# replace directive, so build it from the exact CPA revision used for review.
RUN git clone --filter=blob:none https://github.com/router-for-me/CLIProxyAPI.git /cpa \
    && git -C /cpa checkout --detach "${CPA_REF}"
WORKDIR /cpa/examples/plugin/claude-web-search-router/go
RUN CGO_ENABLED=1 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -buildmode=c-shared -trimpath -o /out/claude-web-search-router.so .

FROM alpine:3.22
COPY --from=build /out/relayapi-bridge.so /relayapi-bridge.so
COPY --from=build /out/claude-web-search-router.so /claude-web-search-router.so
COPY install-plugin.sh /usr/local/bin/install-plugin
RUN chmod 0755 /usr/local/bin/install-plugin
CMD ["/usr/local/bin/install-plugin"]
