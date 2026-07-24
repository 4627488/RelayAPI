FROM golang:1.24-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -buildmode=c-shared -trimpath -o /out/relayapi-bridge.so .

FROM alpine:3.22
COPY --from=build /out/relayapi-bridge.so /relayapi-bridge.so
CMD ["cp", "/relayapi-bridge.so", "/plugins/relayapi-bridge.so"]
